// 无痛切 core 隔离回归测试（零依赖，只用 node:assert）。
//
// 覆盖 1.2.0 计划里 core 侧的剩余部分：
//   · 无变化快路径（reused）与缓存失效：删除/损坏 TOTAL、改动段文件、配置变化；
//   · 只新增被过滤的系统消息时，LIVE 摘要与总摘要都直接复用；
//   · 有界 rolling merge：只提交"上一版总摘要 + 新增段 + 最新 LIVE"，旧正文从 state 读（草稿覆盖 TOTAL 也不受影响）；
//   · 阈值/预算/前缀不满足时回退全量 map-reduce；merge 失败保存机械 fallback 且缓存不再永久命中；
//   · 草稿与 scan/final 的并发合并：processed 只增不减、旧 state 不覆盖新 final、草稿不覆盖更新的 final；
//   · 会话目录被改名 / 标题漂移后，仍按 meta.json 的 sessionId 解析到原目录，不分裂数据；
//   · TOTAL/state 采用原子写入，不留下半截文件。
//
// 隔离策略（与 scripts/tests.handoff.mjs 同一套思路，但本文件完全自包含）：
//   · 所有数据写在 <项目>/.zcode/tests/.tmp-core/<runId>/ 下，跑完即删（--keep 保留）；
//   · HOME/USERPROFILE 指向临时目录，provider 配置为假配置（假 key，仅用于通过解析）；
//   · 注册 mock 会话源，不读真实 db.sqlite；
//   · 全局 fetch 被替换：只应答本地构造的假响应，其它请求一律拒绝，绝不访问真实远端；
//   · 不读取/打印任何真实密钥，不触碰真实 .无痛切 目录。
//
// 运行：node .zcode/tests/core-regression.mjs [--keep]

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ==================== 0. 临时目录与环境（必须在 import 核心模块之前） ==================== */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const PLUGIN_DIR = join(PROJECT_ROOT, "plugins", "wutongqie");
const RUN_ID = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${process.pid}`;
const TMP_ROOT = join(HERE, ".tmp-core", RUN_ID);
const TMP_HOME = join(TMP_ROOT, "home");
const PLUGIN_DATA = join(TMP_ROOT, "plugin-data");
const OUT_ROOT = join(TMP_ROOT, "output");
const FIX_DIR = join(TMP_ROOT, "fixtures");
const WS = join(TMP_ROOT, "ws");
const KEEP = process.argv.includes("--keep");

{
  const low = (p) => resolve(p).toLowerCase();
  assert.ok(low(TMP_ROOT).startsWith(low(PROJECT_ROOT)), `临时目录必须在项目内: ${TMP_ROOT}`);
  assert.ok(!low(TMP_ROOT).includes(low(join(PROJECT_ROOT, ".无痛切"))), "临时目录不得靠近真实归档目录");
}
for (const dir of [TMP_HOME, PLUGIN_DATA, OUT_ROOT, FIX_DIR, WS]) mkdirSync(dir, { recursive: true });

// provider 假配置：让 llm.mjs 的 provider 选择逻辑能跑通，密钥是假字符串，且所有请求都由本地假 fetch 截住。
mkdirSync(join(TMP_HOME, ".zcode", "v2"), { recursive: true });
writeFileSync(
  join(TMP_HOME, ".zcode", "v2", "provider_config.json"),
  JSON.stringify(
    {
      config: {
        providerOrder: ["fixture-provider"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "fixture-provider",
              providerName: "Fixture Provider",
              enabled: true,
              config: {
                api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/fixture" },
                access: { apiKey: "fixture-key-not-real" },
                personalModelIds: ["fixture-model"],
                modelOrder: ["fixture-model"],
              },
            },
          ],
        },
      },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.ZCODE_PLUGIN_DATA = PLUGIN_DATA;
process.env.WTQ_OUTPUT_ROOT = join(OUT_ROOT, "default");
process.env.ZCODE_PROJECT_DIR = WS;
delete process.env.ZCODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.WTQ_TEST_FIXTURE;
delete process.env.WTQ_TEST_PRELOAD;

/* ==================== 1. mock 会话源 + 假 fetch ==================== */

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const normPath = (value) => {
  const p = resolve(String(value ?? "")).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? p.toLowerCase() : p;
};

function readFixtureFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const TRANSCRIPT_KINDS = new Set(["user_prompt", "assistant_response"]);

function createMockSource() {
  return {
    id: "zcode",
    name: "core-regression fixture",
    default: true,

    listSessions({ cwd, limit = 30, includeSubagents = false } = {}) {
      const fx = readFixtureFile(process.env.WTQ_CORE_FIXTURE);
      return (fx.sessions ?? [])
        .filter((s) => includeSubagents || !String(s.id).startsWith("sess_subagent_"))
        .filter((s) => !cwd || normPath(s.cwd) === normPath(cwd))
        .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
        .slice(0, limit)
        .map((s) => ({ id: s.id, title: s.title ?? "(无标题)", cwd: s.cwd, createdAt: s.createdAt ?? null, updatedAt: s.updatedAt ?? null }));
    },

    getSession(sessionId) {
      const fx = readFixtureFile(process.env.WTQ_CORE_FIXTURE);
      const s = (fx.sessions ?? []).find((x) => x.id === sessionId);
      return s ? { id: s.id, title: s.title ?? "(无标题)", slug: null, cwd: s.cwd, createdAt: s.createdAt ?? null, updatedAt: s.updatedAt ?? null } : null;
    },

    maxSequence(sessionId) {
      const fx = readFixtureFile(process.env.WTQ_CORE_FIXTURE);
      const seqs = (fx.messages?.[sessionId] ?? []).map((m) => m.sequence);
      return seqs.length ? Math.max(...seqs) : -1;
    },

    listCompactions(sessionId) {
      const fx = readFixtureFile(process.env.WTQ_CORE_FIXTURE);
      return (fx.compactions?.[sessionId] ?? [])
        .filter((c) => typeof c.tailSequence === "number")
        .slice()
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    },

    getSegment(sessionId, fromSeq, toSeq) {
      const fx = readFixtureFile(process.env.WTQ_CORE_FIXTURE);
      const rows = (fx.messages?.[sessionId] ?? [])
        .filter((m) => m.sequence > fromSeq && m.sequence < toSeq)
        .sort((a, b) => a.sequence - b.sequence);
      if (!rows.length) {
        return { messages: [], stats: { fromSeq: null, toSeq: null, totalRows: 0, userCount: 0, assistantCount: 0, toolCount: 0, hiddenRows: 0 } };
      }
      let hidden = 0;
      let userCount = 0;
      let assistantCount = 0;
      const messages = [];
      for (const m of rows) {
        const kind = m.kind ?? null;
        const time = typeof m.time === "string" ? Date.parse(m.time) : m.time ?? null;
        if (kind === "compact_summary") {
          hidden++;
          messages.push({ id: m.id, sequence: m.sequence, time, role: "user", kind, special: "official-summary", title: m.summaryTitle ?? "Compact summary", text: m.summaryBody ?? "", parts: [] });
          continue;
        }
        if (!TRANSCRIPT_KINDS.has(kind)) {
          hidden++;
          continue;
        }
        const role = m.role ?? (kind === "user_prompt" ? "user" : "assistant");
        const parts = m.text != null && String(m.text).length ? [{ sequence: 1, data: { type: "text", text: String(m.text) } }] : [];
        if (role === "user") userCount++;
        else assistantCount++;
        messages.push({ id: m.id, sequence: m.sequence, time, role, kind, special: null, parts });
      }
      return { messages, stats: { fromSeq, toSeq, totalRows: rows.length, userCount, assistantCount, toolCount: 0, hiddenRows: hidden } };
    },
  };
}

/** 假模型：按 prompt 分类 chunk/total，回固定可辨识正文；支持按模式失败，并记录每次调用。 */
const llm = {
  calls: [],
  mode: "ok", // ok | fail-total | fail-chunk | fail-all
  reset() {
    this.calls = [];
    this.mode = "ok";
  },
  totalCalls() {
    return this.calls.filter((c) => c.kind === "total");
  },
  chunkCalls() {
    return this.calls.filter((c) => c.kind === "chunk");
  },
};

function mockResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

globalThis.fetch = async function coreRegressionFetch(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = String(init?.method ?? (typeof input === "object" && input?.method) ?? "GET").toUpperCase();
  if (method !== "POST" || !/\/chat\/completions(?:[?#]|$)/.test(url)) {
    return new Response(JSON.stringify({ error: { message: `blocked by core-regression fetch stub: ${method} ${url}` } }), { status: 502 });
  }
  const payload = JSON.parse(init?.body ?? "{}");
  const messages = payload.messages ?? [];
  const system = String(messages.find((m) => m?.role === "system")?.content ?? "");
  const kind = /总对话摘要/.test(system) ? "total" : "chunk";
  const prompt = JSON.stringify(messages);
  const n = llm.calls.filter((c) => c.kind === kind).length + 1;
  const fail = llm.mode === "fail-all" || (llm.mode === "fail-chunk" && kind === "chunk") || (llm.mode === "fail-total" && kind === "total");
  const entry = { kind, n, prompt, url, ok: !fail };
  llm.calls.push(entry);
  if (fail) {
    return new Response(JSON.stringify({ error: { message: `core-regression fixture refusal (mode=${llm.mode})` } }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const text =
    kind === "total"
      ? [
          "# 1. 一句话总览",
          `TOTAL-SUM-${n} 夹具总摘要（第 ${n} 次归并调用）`,
          "",
          "# 2. 最终结论与待办",
          "**已完成**",
          "- TOTAL-CONCLUSION 夹具结论",
          "",
          "# 3. 关键决策全表",
          "- TOTAL-DECISION 夹具决策",
          "",
          "# 4. 用户偏好与硬约束",
          "- TOTAL-CONSTRAINT 夹具约束",
          "",
          "# 5. 重要产出清单",
          "- TOTAL-ARTIFACT 夹具产出",
          "",
          "# 6. 时间线",
          "- TOTAL-TIMELINE 夹具时间线",
        ].join("\n")
      : [
          "# 1. 目标与意图",
          `CHUNK-SUM-${n} 夹具段摘要（第 ${n} 次段摘要调用）`,
          "",
          "# 2. 已完成事项",
          "- 无",
          "",
          "# 3. 关键决策与理由",
          "- 无",
          "",
          "# 4. 产出文件与代码位置",
          "- 无",
          "",
          "# 5. 未决问题",
          "- 无",
          "",
          "# 6. 用户偏好与硬约束",
          "- 无",
        ].join("\n");
  return mockResponse({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    model: "fixture-model",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
};

/* ==================== 2. 加载核心模块 ==================== */

const sources = await import(pathToFileURL(join(PLUGIN_DIR, "core", "sources", "index.mjs")).href);
sources.registerSource(createMockSource());
const archive = await import(pathToFileURL(join(PLUGIN_DIR, "core", "archive.mjs")).href);
const draftMod = await import(pathToFileURL(join(PLUGIN_DIR, "core", "draft.mjs")).href);
const summarize = await import(pathToFileURL(join(PLUGIN_DIR, "core", "summarize.mjs")).href);
const store = await import(pathToFileURL(join(PLUGIN_DIR, "core", "store.mjs")).href);

const { getSource } = sources;
const { buildTotal, scanSession } = archive;
const { createDraft } = draftMod;
const { buildTotalSummary } = summarize;

assert.equal(getSource("zcode").name, "core-regression fixture", "mock 源未生效");

/* ==================== 3. 夹具与小工具 ==================== */

function msg(sid, seq, kind, text) {
  return { id: `${sid}_m${seq}`, sequence: seq, time: T0 + seq * 60_000, role: kind === "user_prompt" ? "user" : "assistant", kind, text };
}

function boundary(id, tail, offsetMs, extra = {}) {
  return {
    boundaryId: id,
    time: iso(T0 + offsetMs),
    startedAt: iso(T0 + offsetMs - 60_000),
    trigger: "auto",
    phase: "main",
    preCompactTokenCount: 1000,
    postCompactTokenCount: 200,
    summarizedMessageCount: 10,
    keptMessageCount: 2,
    summaryMessageIds: [],
    officialSummary: null,
    tailSequence: tail,
    ...extra,
  };
}

function baseSession(sid, title = "core 回归会话") {
  return {
    sessions: [{ id: sid, title, cwd: WS, createdAt: iso(T0), updatedAt: iso(T0 + 10_000_000) }],
    messages: {
      [sid]: [
        msg(sid, 1, "user_prompt", "OLD-ONE 已被压缩"),
        msg(sid, 2, "assistant_response", "OLD-TWO 已被压缩"),
        msg(sid, 3, "user_prompt", "OLD-THREE 已被压缩"),
        msg(sid, 4, "user_prompt", "KEEP-ONE 边界保留"),
        msg(sid, 5, "assistant_response", "LIVE-ONE 当前内容"),
        msg(sid, 6, "user_prompt", "LIVE-TWO 当前内容"),
      ],
    },
    compactions: { [sid]: [boundary("b1", 4, 3_600_000)] },
  };
}

function writeFixture(name, data) {
  const file = join(FIX_DIR, name);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  process.env.WTQ_CORE_FIXTURE = file;
  return file;
}

function appendMessages(fixturePath, sid, rows) {
  const fx = readFixtureFile(fixturePath);
  fx.messages[sid] = [...(fx.messages[sid] ?? []), ...rows];
  writeFileSync(fixturePath, JSON.stringify(fx, null, 2) + "\n", "utf8");
}

function appendCompaction(fixturePath, sid, compact) {
  const fx = readFixtureFile(fixturePath);
  fx.compactions[sid] = [...(fx.compactions[sid] ?? []), compact];
  writeFileSync(fixturePath, JSON.stringify(fx, null, 2) + "\n", "utf8");
}

function cfgFor(name, extra = {}) {
  return {
    outputRoot: join(OUT_ROOT, name),
    saveRaw: true,
    toolOutputPreview: 240,
    maxMessageChars: 4000,
    maxTranscriptChars: 200000,
    mergeBudgetChars: 60000,
    announce: false,
    panelPort: 0,
    llmProviderId: "",
    llmModelId: "",
    llmTimeoutMs: 8000,
    skipLiveForTotal: false,
    ...extra,
  };
}

const readText = (p) => readFileSync(p, "utf8");
const exists = (p) => existsSync(p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failed = [];
async function test(name, fn) {
  llm.reset();
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed.push({ name, message: String(err?.stack ?? err).slice(0, 2500) });
    console.log(`  FAIL ${name}`);
    for (const line of String(err?.message ?? err).split("\n").slice(0, 8)) console.log(`       ${line}`);
  }
}

const pathsFor = (sessionId, cfg) => store.sessionPaths(WS, getSource("zcode").getSession(sessionId), cfg);
const tmpFilesUnder = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".tmp")) : []);

/* ==================== 4. 缓存：无变化快路径与失效 ==================== */

console.log(`无痛切 core 回归测试 · ${RUN_ID}`);
console.log(`临时目录: ${TMP_ROOT}\n== 缓存（reused / 删除 / 损坏 / 内容变化）==`);

await test("无变化时命中 reused：0 模型调用、不重写 TOTAL、亚秒级", async () => {
  const sid = "sess_core_cache1";
  const fixture = writeFixture("cache.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("cache");
  const paths = pathsFor(sid, cfg);

  const first = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(first.chunkCount, 2, "1 段历史 + 当前未压缩内容");
  assert.equal(first.reused, undefined, "首次生成不应是复用");
  assert.ok(Number.isFinite(first.usage.totalTokens) && first.usage.totalTokens === 150, "usage 应为真实模型返回");
  assert.equal(first.passes, 1, "单层归并应为 1 次调用");
  assert.equal(first.model, "Fixture Provider/fixture-model");
  const beforeText = readText(paths.total);
  const beforeMtime = statSync(paths.total).mtimeMs;
  const callsAfterFirst = llm.calls.length;
  assert.equal(callsAfterFirst, 3, "1 段摘要 + LIVE 摘要 + 总归并 = 3 次调用");

  const started = Date.now();
  const second = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const elapsed = Date.now() - started;
  assert.equal(second.reused, true);
  assert.equal(second.cached, true);
  assert.equal(llm.calls.length, callsAfterFirst, "复用不得再调模型");
  assert.equal(readText(paths.total), beforeText, "复用不得重写 TOTAL.md");
  assert.equal(statSync(paths.total).mtimeMs, beforeMtime, "TOTAL.md mtime 不应变化");
  assert.ok(elapsed < 3000, `复用应为亚秒级（实际 ${elapsed}ms）`);
});

await test("TOTAL.md 被删除/损坏后不再命中缓存，会重新生成", async () => {
  const sid = "sess_core_cache2";
  const fixture = writeFixture("cache-corrupt.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("cache-corrupt");
  const paths = pathsFor(sid, cfg);

  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });

  unlinkSync(paths.total);
  const afterDelete = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.notEqual(afterDelete.reused, true, "TOTAL 被删除后不得命中缓存");
  const rebuilt = readText(paths.total);
  assert.match(rebuilt, /TOTAL-SUM-\d/, "删除后应重建出完整交接正文");
  assert.match(rebuilt, /chunk_count: 2/);
  assert.match(rebuilt, /live_included: true/);
  assert.ok(!rebuilt.includes("fallback: true"));

  writeFileSync(paths.total, rebuilt.slice(0, Math.floor(rebuilt.length / 2)), "utf8");
  const afterCorrupt = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.notEqual(afterCorrupt.reused, true, "TOTAL 被截断后不得命中缓存");
  assert.match(readText(paths.total), /TOTAL-SUM-\d/, "损坏的 TOTAL 应被完整重建覆盖");
  assert.equal(store.totalContentHash(paths), JSON.parse(readText(paths.state)).totalContentHash, "state 里的内容哈希必须与文件一致");
});

await test("段文件内容变动（哈希变化）后缓存失效并全量重建", async () => {
  const sid = "sess_core_cache3";
  const fixture = writeFixture("cache-chunk.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("cache-chunk");
  const paths = pathsFor(sid, cfg);

  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const file = store.listChunkFiles(paths.dir)[0];
  writeFileSync(join(paths.dir, file), readText(join(paths.dir, file)) + "\n<!-- 手工追加改动 -->\n", "utf8");

  const before = llm.calls.length;
  const again = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.notEqual(again.reused, true, "段文件内容变了不得命中缓存");
  assert.ok(llm.calls.length > before, "应重新归并");
  const totalCall = llm.calls.slice(before).filter((c) => c.kind === "total").at(-1);
  assert.ok(totalCall.prompt.includes("手工追加改动"), "重建的归并输入应包含改动后的段摘要正文");
});

await test("影响内容的配置变化后缓存失效", async () => {
  const sid = "sess_core_cache4";
  const fixture = writeFixture("cache-config.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("cache-config");
  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });

  const before = llm.calls.length;
  const changed = await buildTotal({ sessionOrId: sid, cwd: WS, cfg: cfgFor("cache-config", { mergeBudgetChars: 12345 }) });
  assert.notEqual(changed.reused, true, "配置变化后不得命中缓存");
  assert.ok(llm.calls.length > before, "应重新归并");
});

await test("只新增被过滤的系统消息：总摘要直接复用，LIVE 摘要也复用", async () => {
  const sid = "sess_core_cache5";
  const fixture = writeFixture("cache-hidden.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("cache-hidden");
  const paths = pathsFor(sid, cfg);

  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const stateBefore = JSON.parse(readText(paths.state));
  const mtimeBefore = statSync(paths.total).mtimeMs;
  appendMessages(fixture, sid, [{ ...msg(sid, 7, "system_reminder", "被过滤的系统消息"), role: "system" }]);

  const before = llm.calls.length;
  const again = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(again.reused, true, "只多了被过滤消息时应命中缓存");
  assert.equal(llm.calls.length, before, "不得调模型");
  assert.equal(again.throughSequence, 7, "展示用的覆盖范围应推进到最新 sequence");
  assert.equal(statSync(paths.total).mtimeMs, mtimeBefore, "TOTAL.md 不应被重写");
  const stateAfter = JSON.parse(readText(paths.state));
  assert.equal(stateAfter.totalThroughSequence, 7, "state 覆盖范围应同步推进");
  assert.equal(stateAfter.liveSummary.inputHash, stateBefore.liveSummary.inputHash, "LIVE 摘要指纹不变、可复用");
  for (const key of ["totalBuiltAt", "totalInputChars", "totalSourceFiles", "totalLiveInputHash", "totalConfigKey", "totalRollingCount", "totalContentHash"]) {
    assert.deepEqual(stateAfter[key], stateBefore[key], `${key} 不能被覆盖范围更新清空`);
  }
  const third = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(third.reused, true, "更新覆盖范围后仍然应命中缓存");
  assert.equal(llm.calls.length, before, "第三次请求仍不得调模型");
  assert.equal(statSync(paths.total).mtimeMs, mtimeBefore, "第三次请求仍不得重写 TOTAL");

  // 让总摘要缓存失效（配置变化）但 LIVE 输入不变：应只发生一次归并调用，LIVE 摘要沿用缓存
  const liveMarker = String(stateAfter.liveSummary.text).split("\n").find((line) => line.includes("CHUNK-SUM-"));
  const liveBuiltAt = stateAfter.liveSummary.builtAt;
  const before2 = llm.calls.length;
  await buildTotal({ sessionOrId: sid, cwd: WS, cfg: cfgFor("cache-hidden", { mergeBudgetChars: 22345 }) });
  const newCalls = llm.calls.slice(before2);
  assert.equal(newCalls.filter((c) => c.kind === "total").length, 1, "应只发生一次归并调用");
  assert.equal(newCalls.filter((c) => c.kind === "chunk").length, 0, "LIVE 输入没变时不得重新摘要 LIVE");
  assert.ok(newCalls.at(-1).prompt.includes("当前未压缩内容"), "归并输入应包含当前未压缩内容");
  assert.ok(newCalls.at(-1).prompt.includes(liveMarker), "归并输入应使用缓存的 LIVE 摘要正文");
  const stateAfter2 = JSON.parse(readText(paths.state));
  assert.equal(stateAfter2.liveSummary.builtAt, liveBuiltAt, "LIVE 摘要不应被重新生成");
});

/* ==================== 5. rolling merge ==================== */

console.log("\n== 有界 rolling merge ==");

await test("有新内容时只做一次滚动归并：提交上一版正文 + 新增段 + 最新 LIVE", async () => {
  const sid = "sess_core_roll1";
  const fixture = writeFixture("rolling.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("rolling");
  const paths = pathsFor(sid, cfg);

  const first = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(first.rolling, false);
  const chunkSummary1 = llm.chunkCalls()[0].n; // 第 1 段摘要
  const total1 = llm.totalCalls()[0].n; // 第 1 次归并

  // 新增一个压缩边界（吞掉 seq 4..7）以及新的活跃内容
  appendMessages(fixture, sid, [
    msg(sid, 7, "assistant_response", "NEW-ONLY-7 新增内容"),
    msg(sid, 8, "user_prompt", "NEW-ONLY-8 新边界保留"),
    msg(sid, 9, "assistant_response", "NEW-ONLY-9 新的活跃内容"),
  ]);
  appendCompaction(fixture, sid, boundary("b2", 8, 7_200_000));

  const before = llm.calls.length;
  const second = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const calls = llm.calls.slice(before);
  assert.deepEqual(calls.map((c) => c.kind), ["chunk", "chunk", "total"], "应只归档新边界 + 摘要 LIVE + 一次滚动归并");
  assert.equal(second.rolling, true, "应走滚动归并");
  assert.equal(second.passes, 1, "滚动归并只应一次模型调用");
  assert.equal(second.usage.calls, 1, "usage 统计应为真实调用数");

  const rollingPrompt = calls.at(-1).prompt;
  assert.ok(rollingPrompt.includes(`TOTAL-SUM-${total1}`), "滚动输入必须带上一版总摘要正文");
  assert.ok(rollingPrompt.includes(`CHUNK-SUM-${calls[0].n}`), "滚动输入必须带新增段摘要");
  assert.ok(rollingPrompt.includes(`CHUNK-SUM-${calls[1].n}`), "滚动输入必须带最新 LIVE 摘要");
  assert.ok(!rollingPrompt.includes(`CHUNK-SUM-${chunkSummary1}`), "不得重新提交旧段摘要");
  assert.ok(!rollingPrompt.includes("OLD-ONE"), "不得重新提交被压缩的旧原文");
  assert.ok(rollingPrompt.includes("优先级最高") || rollingPrompt.includes("以这部分为准"), "prompt 必须明确新增内容优先");
  assert.ok(rollingPrompt.includes("替换"), "prompt 必须说明 LIVE 旧内容被替换而不是并列");

  const totalText = readText(paths.total);
  assert.match(totalText, /rolling: true/);
  assert.match(totalText, new RegExp(`TOTAL-SUM-${calls.at(-1).n}`));
  const state = JSON.parse(readText(paths.state));
  assert.equal(state.totalRollingCount, 1, "滚动计数应累加");
  assert.equal(state.rollingBase.rollingCount, 1);
  assert.equal(state.rollingBase.body.includes(`TOTAL-SUM-${calls.at(-1).n}`), true, "rollingBase 应保存最终正文（不含头部）");
  assert.ok(!readText(paths.total).includes("draft: true"), "最终版不应残留草稿标记");
});

await test("草稿覆盖 TOTAL.md 后，滚动归并仍从独立 state 读取最终正文", async () => {
  const sid = "sess_core_roll2";
  const fixture = writeFixture("rolling-draft.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("rolling-draft");
  const paths = pathsFor(sid, cfg);

  const first = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const total1 = llm.totalCalls()[0].n;
  assert.equal(first.rolling, false);

  // 草稿覆盖 TOTAL.md：最终正文仍在 state.rollingBase 里
  const draftResult = createDraft({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(draftResult.draft.isDraft, true);
  assert.match(readText(paths.total), /draft: true/, "前置：TOTAL.md 应先被草稿覆盖");
  assert.ok(!readText(paths.total).includes(`TOTAL-SUM-${total1}`), "前置：草稿里不应有上一版最终正文");

  appendMessages(fixture, sid, [msg(sid, 7, "assistant_response", "AFTER-DRAFT-7")]);
  appendCompaction(fixture, sid, boundary("b2", 6, 7_200_000)); // 吞掉 seq 5 之前的段

  const before = llm.calls.length;
  const second = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const totalCall = llm.calls.slice(before).filter((c) => c.kind === "total").at(-1);
  assert.equal(second.rolling, true, "草稿覆盖 TOTAL.md 不应阻止滚动归并");
  assert.ok(totalCall.prompt.includes(`TOTAL-SUM-${total1}`), "滚动输入必须来自 state 里保存的最终正文");
  assert.match(readText(paths.total), /rolling: true/);
  const state = JSON.parse(readText(paths.state));
  assert.equal(state.draft, null, "新最终版应作废旧草稿");
  assert.equal(state.total.isDraft, false);
});

await test("前缀不连续（旧段文件被改动）时回退全量 map-reduce", async () => {
  const sid = "sess_core_roll3";
  const fixture = writeFixture("rolling-prefix.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("rolling-prefix");
  const paths = pathsFor(sid, cfg);

  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  appendMessages(fixture, sid, [
    msg(sid, 7, "assistant_response", "PREFIX-7"),
    msg(sid, 8, "user_prompt", "PREFIX-8 保留"),
    msg(sid, 9, "assistant_response", "PREFIX-9 活跃"),
  ]);
  appendCompaction(fixture, sid, boundary("b2", 8, 7_200_000));
  const file = store.listChunkFiles(paths.dir)[0];
  writeFileSync(join(paths.dir, file), readText(join(paths.dir, file)) + "\n<!-- 旧段被改动 -->\n", "utf8");

  const before = llm.calls.length;
  const rebuilt = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const totalCall = llm.calls.slice(before).filter((c) => c.kind === "total").at(-1);
  assert.equal(rebuilt.rolling, false, "前缀对不上时必须回退全量");
  assert.ok(totalCall.prompt.includes("CHUNK-SUM-1"), "全量归并输入应包含最早的段摘要");
  assert.match(readText(paths.total), /fallback: false/);
  assert.match(readText(paths.total), /rolling: false/);
});

await test("达到周期性全量重建阈值时不再滚动", async () => {
  const sid = "sess_core_roll4";
  const fixture = writeFixture("rolling-threshold.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("rolling-threshold", { rollingMaxCount: 1 });
  const paths = pathsFor(sid, cfg);

  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  appendMessages(fixture, sid, [
    msg(sid, 7, "assistant_response", "THRESHOLD-7"),
    msg(sid, 8, "user_prompt", "THRESHOLD-8 保留"),
    msg(sid, 9, "assistant_response", "THRESHOLD-9 活跃"),
  ]);
  appendCompaction(fixture, sid, boundary("b2", 8, 7_200_000));
  const rolled = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(rolled.rolling, true, "第一次滚动应被允许（阈值 1 表示只允许 1 次）");
  assert.equal(JSON.parse(readText(paths.state)).totalRollingCount, 1);

  appendMessages(fixture, sid, [msg(sid, 10, "user_prompt", "THRESHOLD-10 再加内容")]);
  const before = llm.calls.length;
  const rebuilt = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const totalCall = llm.calls.slice(before).filter((c) => c.kind === "total").at(-1);
  assert.equal(rebuilt.rolling, false, "达到阈值后必须全量重建");
  assert.ok(totalCall.prompt.includes("CHUNK-SUM-1"), "全量重建应包含全部历史段");
  assert.equal(JSON.parse(readText(paths.state)).totalRollingCount, 0, "全量重建后滚动计数归零");
});

await test("增量规模超过预算时回退全量 map-reduce", async () => {
  const sid = "sess_core_roll5";
  const fixture = writeFixture("rolling-budget.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("rolling-budget");
  const paths = pathsFor(sid, cfg);

  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  appendMessages(fixture, sid, [msg(sid, 7, "assistant_response", "BUDGET-7")]);
  const tight = cfgFor("rolling-budget", { mergeBudgetChars: 1 });
  const before = llm.calls.length;
  const rebuilt = await buildTotal({ sessionOrId: sid, cwd: WS, cfg: tight });
  assert.equal(rebuilt.rolling, false, "预算不足时必须回退全量");
  assert.ok(llm.calls.slice(before).some((c) => c.kind === "total"));
  assert.match(readText(paths.total), /rolling: false/);
});

/* ==================== 6. 机械 fallback ==================== */

console.log("\n== 机械 fallback ==");

await test("归并模型失败：保存可读机械版、带 isFallback/warning，且日志不记录正文", async () => {
  const sid = "sess_core_fb1";
  const fixture = writeFixture("fallback.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("fallback");
  const paths = pathsFor(sid, cfg);

  llm.mode = "fail-total";
  const total = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(total.isFallback, true, "归并失败必须标记 isFallback");
  assert.equal(total.isDraft, false);
  assert.equal(total.passes, 0);
  assert.ok(total.warnings.some((w) => w.includes("机械拼接版")), `warnings 应说明机械版：${JSON.stringify(total.warnings)}`);
  assert.ok(exists(paths.total), "机械版也应落盘 TOTAL.md");
  const text = readText(paths.total);
  assert.match(text, /fallback: true/);
  assert.ok(text.includes("CHUNK-SUM-1"), "机械版必须包含已归档段摘要正文");
  assert.ok(text.includes("CHUNK-SUM-2"), "机械版必须包含当前未压缩内容的摘要");
  assert.ok(text.includes("当前未压缩内容"), "机械版必须标明当前未压缩内容");
  assert.ok(text.includes("机械拼接原因"), "机械版必须说明原因");

  const state = JSON.parse(readText(paths.state));
  assert.equal(state.total.isFallback, true);
  assert.equal(state.lastFinalTotal, null, "没有成功过就不该伪造最终版");
  assert.equal(state.rollingBase, null, "机械版不能作为滚动底稿");

  const logFile = join(PLUGIN_DATA, "archive.log.jsonl");
  assert.ok(exists(logFile), "应写入日志");
  const log = readText(logFile);
  assert.ok(log.includes("total-fallback"), "日志应记录 fallback 事件");
  assert.ok(!log.includes("CHUNK-SUM-"), "日志不得记录摘要正文");
  assert.ok(!log.includes("LIVE-ONE"), "日志不得记录对话正文");
});

await test("机械 fallback 之后模型恢复：缓存不得继续命中，会重试模型", async () => {
  const sid = "sess_core_fb2";
  const fixture = writeFixture("fallback-retry.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("fallback-retry");
  const paths = pathsFor(sid, cfg);

  llm.mode = "fail-total";
  const failed = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(failed.isFallback, true);

  llm.mode = "ok";
  const before = llm.calls.length;
  const retried = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.notEqual(retried.reused, true, "机械版不得被当成最终版命中缓存");
  assert.ok(llm.calls.slice(before).some((c) => c.kind === "total"), "必须重试模型");
  assert.equal(retried.isFallback, false);
  assert.match(readText(paths.total), /TOTAL-SUM-\d/);
  assert.match(readText(paths.total), /fallback: false/);
  const state = JSON.parse(readText(paths.state));
  assert.equal(state.total.isFallback, false);
  assert.ok(state.rollingBase?.body, "成功重试后应补齐滚动底稿");
});

/* ==================== 7. 草稿 / scan / final 并发合并 ==================== */

console.log("\n== 草稿与 scan/final 合并 ==");

await test("草稿不标记 processed：scan 仍会归档待处理边界", async () => {
  const sid = "sess_core_draft1";
  const fixture = writeFixture("draft.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("draft");
  const paths = pathsFor(sid, cfg);

  const draftResult = createDraft({ sessionOrId: sid, cwd: WS, cfg });
  const state = JSON.parse(readText(paths.state));
  assert.equal(state.draft.isDraft, true);
  assert.equal(state.draft.pendingCount, 1, "草稿应报告 1 个待归档边界");
  assert.deepEqual(state.processed, [], "草稿绝不能把待归档边界标记为 processed");
  assert.deepEqual(store.listChunkFiles(paths.dir), [], "草稿不写段文件");
  assert.match(readText(paths.total), /draft: true/);
  assert.match(readText(paths.total), /OLD-ONE/, "草稿必须包含待归档区间的原文");
  assert.match(readText(paths.total), /LIVE-ONE/, "草稿必须包含当前未压缩内容");
  assert.equal(draftResult.draft.liveIncluded, true);

  const scanned = await scanSession(sid, { cwd: WS, cfg });
  assert.equal(scanned.newCount, 1, "scan 必须仍然归档这个边界");
  assert.ok(JSON.parse(readText(paths.state)).processed.includes("b1"));
  assert.equal(JSON.parse(readText(paths.state)).draft?.builtAt, state.draft.builtAt, "scan 不能抹掉更新更晚的草稿");
});

await test("最终版发布后草稿自动作废；scan 中间态不会覆盖新 final", async () => {
  const sid = "sess_core_draft2";
  const fixture = writeFixture("draft-final.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("draft-final");
  const paths = pathsFor(sid, cfg);

  createDraft({ sessionOrId: sid, cwd: WS, cfg });
  const total = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const state = JSON.parse(readText(paths.state));
  assert.equal(state.draft, null, "最终版比草稿新时必须作废草稿");
  assert.equal(state.total.builtAt, total.builtAt);
  assert.equal(state.totalContentHash, store.sha256(readText(paths.total)));

  const finalBuiltAt = state.total.builtAt;
  const finalText = readText(paths.total);
  // 模拟一个更早读到旧 state 的写入者（scan 中间态/旧进程）：既带旧 total 又带更旧的草稿
  store.mergeState(paths, {
    processed: [],
    chunkIndex: 0,
    totalBuiltAt: "2000-01-01T00:00:00.000Z",
    total: { ...state.total, builtAt: "2000-01-01T00:00:00.000Z", sessionTitle: "旧标题" },
    totalContentHash: "stale-hash",
    draft: { ...state.draft, builtAt: "2000-01-01T00:00:00.000Z" },
    draftBuiltAt: "2000-01-01T00:00:00.000Z",
  });
  const merged = JSON.parse(readText(paths.state));
  assert.equal(merged.total.builtAt, finalBuiltAt, "旧 state 不得覆盖更新的最终版");
  assert.equal(merged.total.sessionTitle, state.total.sessionTitle);
  assert.equal(merged.totalContentHash, state.totalContentHash);
  assert.equal(merged.draft, null, "比最终版旧的草稿不得复活");
  assert.ok(merged.processed.includes("b1"), "processed 只能并集、不能回退");
  assert.equal(merged.chunkIndex, state.chunkIndex, "chunkIndex 取最大，不能回退");
  assert.equal(readText(paths.total), finalText, "TOTAL.md 不应被旧写入者改动");
});

await test("草稿构造期间已有更新最终版落盘：草稿不覆盖文件", async () => {
  const sid = "sess_core_draft3";
  const fixture = writeFixture("draft-race.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("draft-race");
  const paths = pathsFor(sid, cfg);

  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const finalText = readText(paths.total);
  // 构造"最终版比草稿开始时间还新"的时序：把 final 的 builtAt 推到未来
  const state = JSON.parse(readText(paths.state));
  const future = new Date(Date.now() + 120_000).toISOString();
  state.totalBuiltAt = future;
  state.total = { ...state.total, builtAt: future };
  state.lastFinalTotal = { ...state.lastFinalTotal, builtAt: future };
  store.writeState(paths, state);

  const result = createDraft({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(result.reusedFinal, true, "应识别出更新的最终版并复用它");
  assert.equal(result.draft.isDraft, false, "复用的交接结果不是草稿");
  assert.equal(readText(paths.total), finalText, "更新的最终版文件不得被草稿覆盖");
  assert.equal(JSON.parse(readText(paths.state)).draft, null, "不得留下比最终版旧的草稿状态");
});

await test("最终版在草稿读后写前发布：从独立快照恢复最终文件", async () => {
  const sid = "sess_core_draft4";
  const fixture = writeFixture("draft-write-race.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("draft-write-race");
  const paths = pathsFor(sid, cfg);
  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const state = store.readState(paths);
  const future = new Date(Date.now() + 120_000).toISOString();
  const finalText = readText(paths.total).replace(/^built_at:.*$/m, `built_at: ${future}`) + "\nFINAL-WRITE-RACE\n";
  const finalHash = store.sha256(finalText);
  const originalWrite = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function (file, data, ...args) {
    if (!injected && String(file).startsWith(paths.total + ".") && String(data).includes("draft: true")) {
      injected = true;
      store.writeTotal(paths, finalText);
      store.writeState(paths, {
        ...state,
        totalBuiltAt: future,
        totalContentHash: finalHash,
        total: { ...state.total, builtAt: future },
        lastFinalTotal: { ...state.total, builtAt: future },
        rollingBase: { ...state.rollingBase, builtAt: future, markdown: finalText },
      });
    }
    return originalWrite.call(fs, file, data, ...args);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = createDraft({ sessionOrId: sid, cwd: WS, cfg });
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true, "测试必须在草稿写入窗口发布最终版");
  assert.equal(result.reusedFinal, true, "返回结果应复用更新最终版");
  assert.equal(result.draft.isDraft, false);
  assert.equal(readText(paths.total), finalText, "最终文件不能被草稿覆盖");
  assert.equal(store.readState(paths).draft, null);
  assert.equal(store.totalContentHash(paths), finalHash);
  assert.deepEqual(tmpFilesUnder(paths.dir), []);
});

await test("原子写入：不留下临时文件、state.json 始终可解析", async () => {
  const sid = "sess_core_atomic1";
  const fixture = writeFixture("atomic.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("atomic");
  const paths = pathsFor(sid, cfg);

  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  createDraft({ sessionOrId: sid, cwd: WS, cfg });
  appendMessages(fixture, sid, [msg(sid, 7, "assistant_response", "ATOMIC-7")]);
  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });

  assert.deepEqual(tmpFilesUnder(paths.dir), [], "会话目录不应残留 .tmp 文件");
  assert.deepEqual(tmpFilesUnder(paths.root), [], "归档根目录不应残留 .tmp 文件");
  assert.deepEqual(tmpFilesUnder(join(paths.root, "sessions")), [], "sessions 目录不应残留 .tmp 文件");
  JSON.parse(readText(paths.state));
  JSON.parse(readText(paths.meta));
  assert.ok(readText(paths.readme).includes("草稿"), "自动生成的 README 应说明立即草稿、后台覆盖");
});

/* ==================== 8. 目录解析（改名 / 标题漂移兜底） ==================== */

console.log("\n== 目录解析（改名 / 标题漂移兜底）==");

await test("会话目录被改名后仍解析到原目录：归档进度与缓存不分裂", async () => {
  const sid = "sess_core_dir1";
  const fixture = writeFixture("dir-rename.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("dir-rename");
  const paths = pathsFor(sid, cfg);
  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const totalText = readText(paths.total);
  const chunks = store.listChunkFiles(paths.dir);

  const renamed = join(paths.root, "sessions", "v1-用户改名");
  renameSync(paths.dir, renamed);
  const paths2 = pathsFor(sid, cfg);
  assert.equal(paths2.dir, renamed, "改名后应通过 meta.json 的 sessionId 找回原目录");
  assert.equal(readText(paths2.total), totalText, "原交接文件必须原样可见");
  assert.deepEqual(store.listChunkFiles(paths2.dir), chunks, "段文件应在新路径下完整可见");

  const again = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  assert.equal(again.reused, true, "改名后重复准备应命中缓存（数据没有分裂重算）");
  const canonical = join(paths.root, "sessions", store.sessionSlug(getSource("zcode").getSession(sid)));
  assert.ok(!existsSync(canonical), "不得另建规范名新目录");
});

await test("会话标题变化后仍解析到原目录", async () => {
  const sid = "sess_core_dir2";
  const fixture = writeFixture("dir-title.json", baseSession(sid, "原始标题"));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("dir-title");
  const paths = pathsFor(sid, cfg);
  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
  const chunks = store.listChunkFiles(paths.dir);

  const fx = readFixtureFile(fixture);
  fx.sessions[0].title = "改过的新标题";
  writeFileSync(fixture, JSON.stringify(fx, null, 2) + "\n", "utf8");

  const driftedSlug = store.sessionSlug(getSource("zcode").getSession(sid));
  assert.notEqual(join(paths.root, "sessions", driftedSlug), paths.dir, "前置：标题变化应导致规范名漂移");
  const paths2 = pathsFor(sid, cfg);
  assert.equal(paths2.dir, paths.dir, "标题漂移后应通过 meta 找回原目录");
  assert.deepEqual(store.listChunkFiles(paths2.dir), chunks, "原段文件不受影响");
});

await test("没有归档的新会话不会被误配到其他会话的目录", async () => {
  const sidA = "sess_core_dir4a";
  const sidB = "sess_core_dir4b";
  const fixture = writeFixture("dir-new.json", baseSession(sidA, "会话A"));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const fx = readFixtureFile(fixture);
  fx.sessions.push({ id: sidB, title: "会话B", cwd: WS, createdAt: iso(T0), updatedAt: iso(T0) });
  writeFileSync(fixture, JSON.stringify(fx, null, 2) + "\n", "utf8");
  const cfg = cfgFor("dir-new");
  const pathsA = pathsFor(sidA, cfg);
  await buildTotal({ sessionOrId: sidA, cwd: WS, cfg });

  const pathsB = pathsFor(sidB, cfg);
  assert.equal(pathsB.dir, join(pathsA.root, "sessions", store.sessionSlug(getSource("zcode").getSession(sidB))), "新会话应落在自己的规范名目录");
  assert.ok(!existsSync(pathsB.dir), "新会话目录尚未创建");
  assert.notEqual(pathsB.dir, pathsA.dir, "不得误配到会话A的目录");
});

await test("改名目录与同名目录并存时，取最近写入的一个", async () => {
  const sid = "sess_core_dir5";
  const fixture = writeFixture("dir-ambiguous.json", baseSession(sid));
  process.env.WTQ_CORE_FIXTURE = fixture;
  const cfg = cfgFor("dir-ambiguous");
  const paths = pathsFor(sid, cfg);
  await buildTotal({ sessionOrId: sid, cwd: WS, cfg });

  const renamed = join(paths.root, "sessions", "v1备份");
  renameSync(paths.dir, renamed);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(join(paths.dir, "state.json"), JSON.stringify({ processed: [] }), "utf8");

  const old = new Date(Date.now() - 600_000);
  utimesSync(join(renamed, "state.json"), old, old);
  assert.equal(pathsFor(sid, cfg).dir, paths.dir, "规范名目录更新时应选它");

  const now = new Date();
  utimesSync(join(renamed, "state.json"), now, now);
  utimesSync(join(paths.dir, "state.json"), old, old);
  assert.equal(pathsFor(sid, cfg).dir, renamed, "mtime 反转后应选改名目录（里面的数据更新）");
});

/* ==================== 9. 归并进度与统计 ==================== */

console.log("\n== 归并批次进度与真实统计 ==");

await test("buildTotalSummary：按批次上报 progress，usage/passes/model 为真实统计", async () => {
  const events = [];
  const chunks = Array.from({ length: 5 }, (_, i) => ({ label: `第 ${i + 1} 段`, file: `${i + 1}.md`, text: "X".repeat(1000) }));
  const result = await buildTotalSummary({
    sessionTitle: "批次统计会话",
    chunks,
    budgetChars: 2200, // 5×1000 字符 → 3 个中间批 + 1 次最终归并
    llm: { providerId: "", modelId: "", timeoutMs: 8000, fallback: true },
    onProgress: (p) => events.push(p),
  });

  assert.equal(result.passes, 4, "3 批 + 1 次最终归并 = 4 次调用");
  assert.equal(result.usage.calls, 4);
  assert.equal(result.usage.inputTokens, 400);
  assert.equal(result.usage.outputTokens, 200);
  assert.equal(result.usage.totalTokens, 600);
  assert.equal(result.model, "fixture-model", "应返回真实模型名");
  assert.equal(result.provider, "Fixture Provider");
  assert.equal(result.rolling, false);

  const mergeEvents = events.filter((e) => e.phase === "merge");
  assert.ok(mergeEvents.length >= 5, "开始 + 每批都应有进度事件");
  assert.deepEqual([...new Set(mergeEvents.map((e) => e.progress))], [0, 1, 2, 3, 4], "progress 必须按实际调用推进，跨层事件允许重复当前进度");
  assert.ok(mergeEvents.every((e) => e.count >= e.progress), "当前层计划不能落后于实际完成调用数");
  assert.ok(mergeEvents.every((e, i) => !i || e.progress >= mergeEvents[i - 1].progress), "跨层进度不能回退");
  assert.equal(mergeEvents.at(-1).count, result.passes);
  assert.ok(mergeEvents.some((e) => e.batches === 3));
});

await test("buildRollingSummary：一次调用、真实用量与模型，进度按 0→1", async () => {
  const events = [];
  const result = await summarize.buildRollingSummary({
    sessionTitle: "滚动统计会话",
    previousBody: "上一版正文",
    additions: [{ label: "第 2 段", file: "02.md", text: "新增内容" }],
    llm: { providerId: "", modelId: "", timeoutMs: 8000, fallback: true },
    onProgress: (p) => events.push(p),
  });
  assert.equal(result.rolling, true);
  assert.equal(result.passes, 1);
  assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.totalTokens, 150);
  assert.equal(result.model, "fixture-model");
  assert.deepEqual(events.map((e) => e.progress), [0, 1]);
});

/* ==================== 9. 汇总 ==================== */

await sleep(50);
console.log(`\n=========== 汇总 ===========`);
console.log(`通过 ${pass} 项，失败 ${failed.length} 项`);
if (failed.length) {
  console.log("\n失败明细：");
  for (const f of failed) {
    console.log(`  x ${f.name}`);
    for (const line of String(f.message).split("\n").slice(0, 8)) console.log(`      ${line}`);
  }
}

if (!KEEP) {
  let removed = !existsSync(TMP_ROOT);
  let lastError = "";
  for (let attempt = 0; !removed && attempt < 2; attempt++) {
    try {
      rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (err) {
      lastError = `${err?.code ?? "?"} ${String(err?.path ?? "")}`;
    }
    removed = !existsSync(TMP_ROOT);
    if (!removed && process.platform === "win32") {
      // 某些 Windows/沙箱环境下 fs.rmSync 会静默不删；cmd rmdir 是可靠兜底。
      const fallback = spawnSync("cmd", ["/c", "rmdir", "/s", "/q", TMP_ROOT], { stdio: "ignore" });
      if (fallback.error) lastError = lastError || String(fallback.error.message);
      removed = !existsSync(TMP_ROOT);
    }
  }
  console.log(removed ? "临时目录已清理" : `临时目录未能自动清理（${lastError || "仍有占用"}），可手动删除: ${TMP_ROOT}`);
} else {
  console.log(`临时目录保留: ${TMP_ROOT}`);
}

process.exit(failed.length ? 1 : 0);
