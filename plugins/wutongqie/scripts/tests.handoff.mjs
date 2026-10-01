// 无痛切「交接链路」自动化测试（零依赖，只用 node:assert）。
//
// 运行方式（在项目根目录）：
//   node plugins/wutongqie/scripts/tests.handoff.mjs                          # 全部用例
//   node plugins/wutongqie/scripts/tests.handoff.mjs --section=core,jobs      # 只跑指定区块
//   node plugins/wutongqie/scripts/tests.handoff.mjs --section=panel          # 只跑面板（需面板重写已合入）
//   node plugins/wutongqie/scripts/tests.handoff.mjs --coverage               # 额外打印覆盖清单
//   node plugins/wutongqie/scripts/tests.handoff.mjs --keep                   # 保留临时目录供排查
//
// 隔离策略：
//   · 所有运行数据都写进 <项目>/.zcode/tests/.tmp-handoff/<runId>/，跑完即删（--keep 保留）。
//   · ZCODE_PLUGIN_DATA 指向该临时目录，绝不碰真实 ~/.zcode 插件数据。
//   · 会话源由 scripts/test-preload.mjs 注册 mock（id 仍是 "zcode"），不读真实 db.sqlite。
//   · LLM 调用由 preload 局部拦截 POST /chat/completions，回固定假响应；不读、不打印任何真实密钥，
//     不访问任何真实远端。子进程（worker/面板）通过 NODE_OPTIONS=--import 继承夹具。
//   · 每个用例用独立 outputRoot，互不污染。
//
// 覆盖范围见 --coverage 输出；对应用户批准的改造计划第六节「测试与验收」。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, utimesSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ==================== 0. 环境与临时目录（必须在动态 import 核心模块之前） ==================== */

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "..");
const PROJECT_ROOT = resolve(HERE, "..", "..", "..");
const PRELOAD_PATH = join(HERE, "test-preload.mjs");
const MCP_PATH = join(PLUGIN_DIR, "mcp", "server.mjs");
const PANEL_LIB_URL = pathToFileURL(join(PLUGIN_DIR, "core", "panel.mjs")).href;

const RUN_ID = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${process.pid}`;
const TMP_ROOT = join(PROJECT_ROOT, ".zcode", "tests", ".tmp-handoff", RUN_ID);
const PLUGIN_DATA = join(TMP_ROOT, "plugin-data");
const OUT_ROOT = join(TMP_ROOT, "output");
const FIX_DIR = join(TMP_ROOT, "fixtures");
const WS = join(TMP_ROOT, "ws");
const WS2 = join(TMP_ROOT, "ws2");
const WS3 = join(TMP_ROOT, "ws-empty");

{
  const low = (s) => resolve(s).toLowerCase();
  assert.ok(
    low(TMP_ROOT).startsWith(low(PROJECT_ROOT)),
    `临时目录必须在项目内: ${TMP_ROOT} vs ${PROJECT_ROOT}`,
  );
}

for (const dir of [PLUGIN_DATA, OUT_ROOT, FIX_DIR, WS, WS2, WS3]) mkdirSync(dir, { recursive: true });

process.env.ZCODE_PLUGIN_DATA = PLUGIN_DATA; // config.mjs 的 PLUGIN_DATA 在 import 时读取
process.env.ZCODE_PROJECT_DIR = WS;
process.env.WTQ_OUTPUT_ROOT = join(OUT_ROOT, "default");
process.env.WTQ_TEST_PRELOAD = "1";
process.env.WTQ_TEST_LLM_MODE = "ok";
process.env.WTQ_TEST_LLM_DELAY_MS = "0";
delete process.env.ZCODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
{
  const parts = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(PRELOAD_PATH).href}`].filter(Boolean);
  process.env.NODE_OPTIONS = parts.join(" ");
}

/* ==================== 1. 加载夹具与核心模块（动态 import，保证 env 先生效） ==================== */

let preload;
let core;
try {
  preload = await import(pathToFileURL(PRELOAD_PATH).href);
  preload.installFixture();
} catch (err) {
  console.error(`[precondition] test-preload 安装失败，为避免真实网络调用直接终止：${err?.stack ?? err}`);
  process.exit(2);
}

core = {
  sources: await import("../core/sources/index.mjs"),
  archive: await import("../core/archive.mjs"),
  current: await import("../core/current-session.mjs"),
  handoff: await import("../core/handoff.mjs"),
  prepare: await import("../core/prepare.mjs"),
  jobs: await import("../core/jobs.mjs"),
  llm: await import("../core/llm.mjs"),
  store: await import("../core/store.mjs"),
  render: await import("../core/render.mjs"),
  config: await import("../core/config.mjs"),
};

const { getSource } = core.sources;
const { scanSession, buildTotal, extractChunkSummary } = core.archive;
const { resolveCurrentSession } = core.current;
const { buildHighlights, buildHandoverText } = core.handoff;
const { prepareSwitch } = core.prepare;
const jobs = core.jobs;
const { listProviders } = core.llm;
const store = core.store;
const { chunkFilename } = core.render;

assert.equal(getSource("zcode").name, "ZCode (test fixture)", "mock 源未生效，测试无法继续");
assert.equal(globalThis.__WTQ_TEST_FETCH__, true, "假 fetch 未安装，测试无法继续");

/* ==================== 2. 参数与最小测试框架 ==================== */

const ARGS = process.argv.slice(2);
const opt = (name, fallback = "") => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => ARGS.includes(`--${name}`);

const ALL_SECTIONS = ["core", "jobs", "prepare", "mcp", "panel"];
const SECTIONS = (opt("section") || ALL_SECTIONS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const KEEP = flag("keep");
const COVERAGE = flag("coverage");
const want = (name) => SECTIONS.includes(name);

const PASS = [];
const FAILED = [];
const SKIPPED = [];
let CURRENT_SECTION = "";

function section(title) {
  CURRENT_SECTION = title;
  console.log(`\n== ${title} ==`);
}

function skip(name, reason) {
  SKIPPED.push({ section: CURRENT_SECTION, name, reason });
  console.log(`  skip ${name}：${reason}`);
}

async function test(name, fn) {
  try {
    await fn();
    PASS.push({ section: CURRENT_SECTION, name });
    console.log(`  ok   ${name}`);
  } catch (err) {
    FAILED.push({ section: CURRENT_SECTION, name, message: redact(err?.stack ?? err) });
    console.log(`  FAIL ${name}`);
    for (const line of String(redact(err?.message ?? err)).split("\n").slice(0, 6)) console.log(`       ${line}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 20000, intervalMs = 150) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

async function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 输出脱敏：宁可少打印，也不让任何 key/token 出现在日志里。 */
function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(sk|pk|api)[-_][A-Za-z0-9._-]{6,}\b/gi, "$1-<redacted>")
    .replace(/"(apiKey|api_key|token|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
    .slice(0, 4000);
}

const readText = (p) => readFileSync(p, "utf8");
const exists = (p) => existsSync(p);
const norm = (p) => {
  let s = resolve(String(p ?? ""));
  s = s.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

function writeFixture(name, data) {
  const file = join(FIX_DIR, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  return file;
}

function appendMessage(fixtureFile, sessionId, message) {
  const fx = JSON.parse(readText(fixtureFile));
  fx.messages[sessionId] = [...(fx.messages[sessionId] ?? []), message];
  writeFileSync(fixtureFile, JSON.stringify(fx, null, 2) + "\n", "utf8");
}

/* ==================== 3. 前置条件：provider 与 preload 继承 ==================== */

const providers = listProviders();
const fixtureProvider =
  providers.find((p) => p.usable && p.enabled && p.models?.length) ??
  providers.find((p) => p.usable && p.models?.length) ??
  null;

const NEED_LLM_SECTIONS = ["core", "jobs", "prepare", "mcp", "panel"];
if (!fixtureProvider && SECTIONS.some((s) => NEED_LLM_SECTIONS.includes(s))) {
  console.error(
    "[precondition] ~/.zcode/v2/provider_config.json 里没有可用的 openai-chat-completions provider。\n" +
      "本套测试虽然全部走假响应，但仍需要一份可解析的 provider 配置来驱动 llm.mjs 的选择逻辑。",
  );
  process.exit(2);
}
if (fixtureProvider) {
  process.env.WTQ_LLM_PROVIDER_ID = fixtureProvider.providerId;
  process.env.WTQ_LLM_MODEL_ID = fixtureProvider.models[0] ?? "";
  console.log(
    `[precondition] provider=${fixtureProvider.name}（${fixtureProvider.providerId.slice(0, 8)}…）/ model=${fixtureProvider.models[0] ?? "-"}（仅用于解析，fetch 全程假响应）`,
  );
}

/** 裸 spawn 子进程（不显式带 --import），专门验证 NODE_OPTIONS 继承路径——worker / 面板就靠这条路径。 */
function runNode(nodeArgs, { envPatch = {}, timeoutMs = 90000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...envPatch },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      reject(new Error(`子进程超时（${timeoutMs}ms）: ${redact(stderr).slice(0, 400)}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

let preloadInherits = false;
{
  const probeFixture = writeFixture("probe.json", { sessions: [], messages: {}, compactions: {} });
  const probeCode = [
    `const src = await import(${JSON.stringify(pathToFileURL(join(PLUGIN_DIR, "core", "sources", "index.mjs")).href)});`,
    `process.stdout.write(JSON.stringify({ name: src.getSource("zcode").name, fetchPatched: globalThis.__WTQ_TEST_FETCH__ === true }) + "\\n");`,
  ].join("\n");
  try {
    const probe = await runNode(["--input-type=module", "-e", probeCode], {
      envPatch: { WTQ_TEST_FIXTURE: probeFixture },
      timeoutMs: 30000,
    });
    const last = probe.stdout.trim().split("\n").filter(Boolean).pop();
    const info = JSON.parse(last);
    preloadInherits = probe.code === 0 && info.fetchPatched === true && String(info.name).includes("fixture");
  } catch (err) {
    console.log(`[precondition] preload 继承探测失败：${redact(err?.message ?? err)}`);
  }
  console.log(`[precondition] 子进程 NODE_OPTIONS 继承夹具：${preloadInherits ? "ok" : "不可用（worker/面板用例将跳过）"}`);
}

/* ==================== 4. 夹具构造 ==================== */

const T0 = Date.parse("2026-09-30T01:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function sessionRow(id, title, cwd, updatedOffsetMs) {
  return { id, title, cwd, createdAt: iso(T0), updatedAt: iso(T0 + updatedOffsetMs) };
}

function msgRow(sessionId, sequence, kind, text, extra = {}) {
  return {
    id: `${sessionId}_m${sequence}`,
    sequence,
    time: T0 + sequence * 60_000,
    role: kind === "user_prompt" ? "user" : "assistant",
    kind,
    text,
    ...extra,
  };
}

function fixtureLiveOnly(sessionId = "sess_liveonly_a1", title = "LIVE-only 会话") {
  const m = (seq, kind, text, extra) => msgRow(sessionId, seq, kind, text, extra);
  return {
    sessions: [sessionRow(sessionId, title, WS, 3_600_000)],
    messages: {
      [sessionId]: [
        m(1, "user_prompt", "LIVEMSG-1 用户问题"),
        m(2, "assistant_response", "LIVEMSG-2 助手回答"),
        m(3, "user_prompt", "LIVEMSG-3 追问"),
        m(4, "assistant_response", "LIVEMSG-4 带工具的回答", {
          tool: "Bash",
          toolTitle: "运行测试",
          toolInput: { command: "node --test" },
          toolOutput: "fixture-output",
        }),
        m(5, "user_prompt", "LIVEMSG-5 收尾"),
        m(6, "assistant_response", "LIVEMSG-6 结束语"),
      ],
    },
    compactions: { [sessionId]: [] },
  };
}

function fixtureTwoSegs(sessionId = "sess_twoseg_b2") {
  const m = (seq, kind, text, extra) => msgRow(sessionId, seq, kind, text, extra);
  return {
    sessions: [sessionRow(sessionId, "两段归档会话", WS, 7_200_000)],
    messages: {
      [sessionId]: [
        m(1, "user_prompt", "OLD-ONE 被压缩"),
        m(2, "assistant_response", "OLD-TWO 被压缩"),
        m(3, "user_prompt", "OLD-THREE 被压缩"),
        m(4, "user_prompt", "RETAINED-ONE 边界一保留"),
        m(5, "assistant_response", "TAIL-ONE"),
        m(6, "user_prompt", "TAIL-TWO"),
        m(7, "assistant_response", "TAIL-THREE"),
        m(8, "user_prompt", "RETAINED-TWO 边界二保留"),
        m(9, "assistant_response", "LIVE-TAIL-ONE"),
        m(10, "user_prompt", "LIVE-TAIL-TWO"),
      ],
    },
    compactions: {
      [sessionId]: [
        {
          boundaryId: "b1",
          time: iso(T0 + 3_600_000),
          startedAt: iso(T0 + 3_500_000),
          trigger: "auto",
          phase: "main",
          compactReason: "context_limit",
          preCompactTokenCount: 1000,
          postCompactTokenCount: 200,
          summarizedMessageCount: 30,
          keptMessageCount: 4,
          tailSequence: 4,
          summaryMessageIds: ["sum_1"],
          officialSummary: "OFFICIAL-SUMMARY-ONE 官方摘要正文",
        },
        {
          boundaryId: "b2",
          time: iso(T0 + 7_200_000),
          startedAt: iso(T0 + 7_100_000),
          trigger: "auto",
          phase: "main",
          compactReason: "context_limit",
          preCompactTokenCount: 2000,
          postCompactTokenCount: 300,
          summarizedMessageCount: 40,
          keptMessageCount: 3,
          tailSequence: 8,
          summaryMessageIds: [],
          officialSummary: null,
        },
      ],
    },
  };
}

function fixtureResolver() {
  return {
    sessions: [
      sessionRow("sess_resolver_a1", "会话A", WS, 1_000),
      sessionRow("sess_resolver_d4", "会话D", WS, 3_000),
      sessionRow("sess_resolver_b2", "会话B", WS, 5_000),
      sessionRow("sess_resolver_c3", "会话C", WS2, 9_000),
      sessionRow("sess_subagent_x", "子代理", WS, 999_000),
      sessionRow("msg_part_tool_1", "内部片段", WS, 888_000),
    ],
    messages: {
      sess_resolver_a1: [msgRow("sess_resolver_a1", 1, "user_prompt", "RESOLVER-A 内容")],
      sess_resolver_d4: [msgRow("sess_resolver_d4", 1, "user_prompt", "RESOLVER-D 内容")],
      sess_resolver_b2: [msgRow("sess_resolver_b2", 1, "user_prompt", "RESOLVER-B 内容")],
      sess_resolver_c3: [msgRow("sess_resolver_c3", 1, "user_prompt", "RESOLVER-C 内容")],
    },
    compactions: {},
  };
}

function fixtureChain(sessionId = "sess_worker_chain1") {
  const m = (seq, kind, text) => msgRow(sessionId, seq, kind, text);
  return {
    sessions: [sessionRow(sessionId, "任务接续会话", WS, 6_000_000)],
    messages: {
      [sessionId]: [
        m(1, "user_prompt", "CHAIN-OLD-1"),
        m(2, "assistant_response", "CHAIN-OLD-2"),
        m(3, "user_prompt", "CHAIN-OLD-3"),
        m(4, "assistant_response", "CHAIN-LIVE-1"),
        m(5, "user_prompt", "CHAIN-LIVE-2"),
      ],
    },
    compactions: {
      [sessionId]: [
        {
          boundaryId: "bc1",
          time: iso(T0 + 1_800_000),
          startedAt: iso(T0 + 1_700_000),
          trigger: "auto",
          phase: "main",
          tailSequence: 4,
          preCompactTokenCount: 900,
          postCompactTokenCount: 150,
          summarizedMessageCount: 20,
          keptMessageCount: 2,
          summaryMessageIds: [],
          officialSummary: null,
        },
      ],
    },
  };
}

/** 连续同尾压缩：b1 真区间（1..3），b2/b3 与上一边界同尾（被吞掉的区间为空），b4 再次产生真区间（4..6）。 */
function fixtureEqualTail(sessionId = "sess_equaltail_e1") {
  const m = (seq, kind, text) => msgRow(sessionId, seq, kind, text);
  const boundary = (id, tail, offsetMs) => ({
    boundaryId: id,
    time: iso(T0 + offsetMs),
    startedAt: iso(T0 + offsetMs - 60_000),
    trigger: "auto",
    phase: "main",
    tailSequence: tail,
    preCompactTokenCount: 1000,
    postCompactTokenCount: 200,
    summarizedMessageCount: 10,
    keptMessageCount: 4,
    summaryMessageIds: [],
    officialSummary: null,
  });
  return {
    sessions: [sessionRow(sessionId, "同尾压缩会话", WS, 4_000_000)],
    messages: {
      [sessionId]: [
        m(1, "user_prompt", "EQUAL-OLD-1"),
        m(2, "assistant_response", "EQUAL-OLD-2"),
        m(3, "user_prompt", "EQUAL-OLD-3"),
        m(4, "assistant_response", "EQUAL-KEEP-4 边界保留"),
        m(5, "user_prompt", "EQUAL-MID-5"),
        m(6, "assistant_response", "EQUAL-MID-6"),
        m(7, "user_prompt", "EQUAL-KEEP-7 边界保留"),
        m(8, "assistant_response", "EQUAL-LIVE-8"),
        m(9, "user_prompt", "EQUAL-LIVE-9"),
      ],
    },
    compactions: {
      [sessionId]: [
        boundary("b1", 4, 1_000_000),
        boundary("b2", 4, 2_000_000), // 与 b1 同尾：没有新的内容被压缩
        boundary("b3", 4, 3_000_000), // 再次同尾
        boundary("b4", 7, 4_000_000),
      ],
    },
  };
}

/** 100+ 段归档：验证段文件/索引/归并输入按数字序号排序，而不是字典序。 */
function fixtureBigSort(sessionId = "sess_bigsort_f1") {
  const m = (seq, kind, text) => msgRow(sessionId, seq, kind, text);
  return {
    sessions: [sessionRow(sessionId, "百段归档会话", WS, 8_000_000)],
    messages: {
      [sessionId]: [
        m(1, "user_prompt", "BIG-LIVE-1 活跃内容"),
        m(2, "assistant_response", "BIG-LIVE-2 活跃内容"),
      ],
    },
    compactions: { [sessionId]: [] },
  };
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
    llmProviderId: fixtureProvider.providerId,
    llmModelId: fixtureProvider.models[0] ?? "",
    llmTimeoutMs: 15000,
    skipLiveForTotal: false,
    ...extra,
  };
}

/* ==================== 5. core：归档 / 总摘要 / 解析 ==================== */

async function coreTests() {
  section("core：交接生成与归档引擎");

  await test("buildTotal：只有未压缩内容也能写出 LIVE.md + TOTAL.md", async () => {
    const fixture = writeFixture("liveonly.json", fixtureLiveOnly());
    const cfg = cfgFor("core-liveonly");
    const sid = "sess_liveonly_a1";
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const session = getSource("zcode").getSession(sid);
      const paths = store.sessionPaths(WS, session, cfg);
      assert.ok(!exists(paths.total), "初始不应有 TOTAL.md");
      assert.ok(!exists(paths.live), "初始不应有 LIVE.md");

      const total = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
      assert.ok(exists(paths.live), "应写入 LIVE.md");
      assert.ok(exists(paths.total), "应写入 TOTAL.md");
      assert.match(readText(paths.total), /live_included: true/);
      assert.match(readText(paths.total), /FIXTURE-OVERVIEW/);
      assert.match(readText(paths.live), /## 归档摘要/);
      assert.match(readText(paths.live), /FIXTURE-CHUNK/);
      assert.equal(total.liveIncluded, true);
      assert.equal(total.chunkCount, 1);
      assert.deepEqual(total.warnings, []);
      assert.equal(total.throughSequence, 6, "throughSequence 应等于当时的 maxSequence");
      assert.match(total.highlights.overview, /FIXTURE-OVERVIEW/);
      assert.match(total.highlights.conclusions, /FIXTURE-CONCLUSION/);
      assert.match(total.highlights.constraints, /FIXTURE-CONSTRAINT/);
      assert.ok(total.handoverText.includes(total.path), "handoverText 应包含交接文档绝对路径");
      assert.equal(total.handoverText, buildHandoverText(total.path));

      const state = JSON.parse(readText(paths.state));
      assert.equal(state.liveThroughSequence, 6);
      assert.equal(state.totalThroughSequence, 6);
      assert.ok(state.totalBuiltAt, "应记录 totalBuiltAt");
      assert.equal(state.total?.path, total.path, "state.total 应持久化交接结果");
    });
  });

  await test("highlights：小节/子标题解析到位，不会串段也不会漏子标题", async () => {
    const md = [
      "# 1. 一句话总览",
      "**FIXTURE-OVERVIEW** 总览正文",
      "",
      "## 2. 最终结论与待办",
      "**已完成**",
      "- 条目一",
      "### 后续建议",
      "- 条目二（子标题下）",
      "",
      "# 3. 关键决策全表",
      "- 不应进入 conclusions",
      "",
      "## 4. 用户偏好与硬约束",
      "- FIXTURE-CONSTRAINT 硬约束正文",
    ].join("\n");
    const hl = buildHighlights(md);
    assert.match(hl.overview, /FIXTURE-OVERVIEW/);
    assert.match(hl.conclusions, /### 后续建议/, "子标题应保留在结论要点里");
    assert.match(hl.conclusions, /条目一/);
    assert.match(hl.conclusions, /条目二（子标题下）/);
    assert.ok(!hl.conclusions.includes("不应进入"), "解析应在下一个同级标题处停止");
    assert.match(hl.constraints, /FIXTURE-CONSTRAINT/);
  });

  await test("scanSession：压缩段首尾相接、边界保留消息出现在下一段开头、重复扫描不重写", async () => {
    const fixture = writeFixture("twoseg.json", fixtureTwoSegs());
    const cfg = cfgFor("core-twoseg");
    const sid = "sess_twoseg_b2";
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const first = await scanSession(sid, { cwd: WS, cfg, summarize: true });
      assert.equal(first.newCount, 2);
      assert.deepEqual(first.errors, []);
      const files = store.listChunkFiles(first.paths.dir);
      assert.equal(files.length, 2);
      const chunk1 = readText(join(first.paths.dir, files[0]));
      const chunk2 = readText(join(first.paths.dir, files[1]));

      // 段摘要文件只存模型摘要；被压缩掉的原文在 raw/ 里，用它验证开区间切段
      const raw1 = readText(join(first.paths.rawDir, files[0]));
      const raw2 = readText(join(first.paths.rawDir, files[1]));
      assert.match(raw1, /OLD-ONE/);
      assert.match(raw1, /OLD-THREE/);
      assert.ok(!raw1.includes("RETAINED-ONE"), "边界一保留的消息不应出现在第一段");
      assert.match(raw2, /boundary .*b2|区间 4\.\.7|RETAINED-ONE/);
      assert.match(raw2, /RETAINED-ONE/, "第二段应从上一边界保留的消息（sequence=4）开始");
      assert.match(raw2, /TAIL-THREE/);
      assert.ok(!raw2.includes("RETAINED-TWO"), "第二段不应包含下一次压缩保留的消息");
      assert.match(raw2, /区间 4\.\.7/, "第二段原文区间应是 sequence 4..7（开区间端点）");

      const source = getSource("zcode");
      const seg1 = source.getSegment(sid, -1, 4);
      assert.deepEqual(seg1.messages.map((m) => m.sequence), [1, 2, 3]);
      assert.deepEqual(seg1.stats, { fromSeq: -1, toSeq: 4, totalRows: 3, userCount: 2, assistantCount: 1, toolCount: 0, hiddenRows: 0 });
      const seg2 = source.getSegment(sid, 3, 8);
      assert.deepEqual(seg2.messages.map((m) => m.sequence), [4, 5, 6, 7]);

      assert.match(chunk2, /boundary_id: "b2"/);
      assert.equal(first.chunks[0].rows, 3, "第一段应是 sequence 1..3（开区间端点）");
      assert.equal(first.chunks[1].rows, 4, "第二段应是 sequence 4..7（开区间端点）");
      assert.equal(first.chunks[0].toolCalls, 0);

      const body = extractChunkSummary(chunk1);
      assert.ok(!body.startsWith("---"), "摘要正文不应带 frontmatter");
      assert.ok(!body.includes("OFFICIAL-SUMMARY-ONE"), "折叠的官方摘要不应混进正文");
      assert.match(body, /FIXTURE-CHUNK/);

      const live = readText(first.paths.live);
      assert.match(live, /RETAINED-TWO/, "LIVE 段应从上一次压缩保留的消息开始");
      assert.match(live, /LIVE-TAIL-TWO/);

      const before = files.map((f) => readText(join(first.paths.dir, f)));
      const beforeRaw = files.map((f) => readText(join(first.paths.rawDir, f)));
      const second = await scanSession(sid, { cwd: WS, cfg, summarize: true });
      assert.equal(second.newCount, 0, "第二次扫描不应重复归档");
      assert.deepEqual(store.listChunkFiles(second.paths.dir), files, "段文件列表不应变化");
      assert.deepEqual(
        files.map((f) => readText(join(second.paths.dir, f))),
        before,
        "段文件内容不应被重写",
      );
      assert.deepEqual(
        files.map((f) => readText(join(second.paths.rawDir, f))),
        beforeRaw,
        "原文文件内容不应被重写",
      );
      const state = JSON.parse(readText(first.paths.state));
      assert.equal(state.chunkIndex, 2);
      assert.equal(state.processed.length, 2);
      assert.equal(new Set(state.processed).size, state.processed.length, "processed 不应有重复 boundaryId");
    });
  });

  await test("LIVE 摘要单独失败：保留 LIVE 原文 + warning，总摘要仍成功", async () => {
    const fixture = writeFixture("liveonly-fallback.json", fixtureLiveOnly());
    const cfg = cfgFor("core-live-fallback");
    const sid = "sess_liveonly_a1";
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "fail-chunk" }, async () => {
      const session = getSource("zcode").getSession(sid);
      const paths = store.sessionPaths(WS, session, cfg);
      const total = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });

      assert.equal(total.liveIncluded, true, "LIVE 摘要失败也必须把活跃段纳入交接");
      assert.ok(
        total.warnings.some((w) => w.includes("当前内容的单独摘要失败")),
        `warnings 应说明 LIVE 摘要失败：${JSON.stringify(total.warnings)}`,
      );
      assert.equal(total.chunkCount, 1);

      const live = readText(paths.live);
      assert.match(live, /LIVEMSG-1/, "失败时应回落到原文，LIVE.md 必须保留内容");
      assert.ok(!live.includes("FIXTURE-CHUNK"), "失败时不应有假成功的摘要正文");

      assert.ok(exists(paths.total), "总摘要本身应成功");
      assert.match(readText(paths.total), /FIXTURE-OVERVIEW/);
      assert.match(readText(paths.total), /当前内容的单独摘要失败/, "交接文档头部应带 warning");
    });
  });

  await test("全部模型调用失败：buildTotal 写入可读机械 fallback，保留 LIVE.md 与 TOTAL.md", async () => {
    const fixture = writeFixture("liveonly-allfail.json", fixtureLiveOnly());
    const cfg = cfgFor("core-allfail");
    const sid = "sess_liveonly_a1";
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "fail" }, async () => {
      const session = getSource("zcode").getSession(sid);
      const paths = store.sessionPaths(WS, session, cfg);
      const total = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });

      assert.equal(total.isFallback, true);
      assert.equal(total.isDraft, false);
      assert.equal(total.model, null);
      assert.equal(total.passes, 0);
      assert.equal(total.usage?.calls, 0);
      assert.match(String(total.fallbackReason), /所有可用的模型都调用失败/);
      assert.ok(total.warnings.some((w) => w.includes("机械拼接版")));
      assert.ok(exists(paths.live), "失败后 LIVE.md 必须保留");
      assert.match(readText(paths.live), /LIVEMSG-1/);
      assert.ok(exists(paths.total), "模型失败时仍应留下可读 TOTAL.md");
      assert.match(readText(paths.total), /fallback: true/);
      assert.match(readText(paths.total), /LIVEMSG-1/);
    });
  });

  await test("maxSequence 快照：无新消息不重写 LIVE；新消息后 liveThrough/totalThrough 有先后（staleness 依据）", async () => {
    const fixture = writeFixture("snapshot.json", fixtureLiveOnly());
    const cfg = cfgFor("core-snapshot");
    const sid = "sess_liveonly_a1";
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const source = getSource("zcode");
      const paths = store.sessionPaths(WS, source.getSession(sid), cfg);

      const total1 = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
      assert.equal(total1.throughSequence, 6);
      const liveBefore = readText(paths.live);
      assert.equal(JSON.parse(readText(paths.state)).liveThroughSequence, 6);

      await scanSession(sid, { cwd: WS, cfg });
      assert.equal(readText(paths.live), liveBefore, "没有新消息时不应重写 LIVE.md");

      appendMessage(fixture, sid, msgRow(sid, 7, "assistant_response", "NEWMSG-7 新内容"));
      assert.equal(source.maxSequence(sid), 7);
      await scanSession(sid, { cwd: WS, cfg });
      assert.equal(JSON.parse(readText(paths.state)).liveThroughSequence, 7, "LIVE 快照应推进到新 maxSequence");
      assert.match(readText(paths.live), /NEWMSG-7/);

      const total2 = await buildTotal({ sessionOrId: sid, cwd: WS, cfg });
      assert.equal(total2.throughSequence, 7, "交接文档应覆盖到生成时的 maxSequence");
      const state = JSON.parse(readText(paths.state));
      assert.equal(state.totalThroughSequence, 7);

      appendMessage(fixture, sid, msgRow(sid, 8, "user_prompt", "NEWMSG-8 又一条"));
      assert.ok(
        source.maxSequence(sid) > state.totalThroughSequence,
        "maxSequence > totalThroughSequence 即面板应提示「交接文档落后于当前对话」",
      );
    });
  });

  await test("buildTotal：旧版归档边界缺消息时自动补齐、原文件不动、warning 可见", async () => {
    const sid = "sess_legacy_a1";
    const fixture = writeFixture("legacy-recover.json", fixtureTwoSegs(sid));
    const cfg = cfgFor("core-legacy-recover");
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const session = getSource("zcode").getSession(sid);
      const paths = store.sessionPaths(WS, session, cfg);
      mkdirSync(paths.dir, { recursive: true });
      const legacyFile = (index, boundaryId, range) =>
        [
          "---",
          `session: "${sid}"`,
          `session_title: "旧版归档会话"`,
          `cwd: "${WS}"`,
          `chunk: ${index}`,
          `boundary_id: "${boundaryId}"`,
          `message_range: "${range}"`,
          "---",
          "",
          `# 第 ${index}/2 段归档摘要 · 旧版归档会话`,
          "",
          "## 归档摘要",
          "",
          "# 1. 目标与意图",
          `LEGACY-BODY-${index} 旧版摘要正文`,
          "",
        ].join("\n");
      // 旧版 bug：第二段从 previousTail+1 开始（range "5..7"），漏掉了上一边界保留的 sequence=4
      const name1 = "01-20260930-1000.md";
      const name2 = "02-20260930-1100.md";
      writeFileSync(join(paths.dir, name1), legacyFile(1, "b1", "1..3"), "utf8");
      writeFileSync(join(paths.dir, name2), legacyFile(2, "b2", "5..7"), "utf8");
      store.writeState(paths, { processed: ["b1", "b2"], chunkIndex: 2, liveThroughSequence: null, liveBoundaryId: null });

      const before = {
        c1: readText(join(paths.dir, name1)),
        c2: readText(join(paths.dir, name2)),
        m1: statSync(join(paths.dir, name1)).mtimeMs,
        m2: statSync(join(paths.dir, name2)).mtimeMs,
      };
      const llmLog = join(TMP_ROOT, "llm-legacy.jsonl");
      const total = await withEnv({ WTQ_TEST_LLM_LOG: llmLog, WTQ_TEST_LLM_PROBE: "RETAINED-ONE" }, () =>
        buildTotal({ sessionOrId: sid, cwd: WS, cfg }),
      );

      assert.ok(
        total.warnings.some((w) => w.includes("已补齐旧版历史记录")),
        `应给出补齐 warning：${JSON.stringify(total.warnings)}`,
      );
      assert.match(readText(total.path), /已补齐旧版历史记录/);

      assert.equal(readText(join(paths.dir, name1)), before.c1, "旧段文件内容不应被修改");
      assert.equal(readText(join(paths.dir, name2)), before.c2, "旧段文件内容不应被修改");
      assert.equal(statSync(join(paths.dir, name1)).mtimeMs, before.m1, "旧段文件 mtime 不应变化");
      assert.equal(statSync(join(paths.dir, name2)).mtimeMs, before.m2, "旧段文件 mtime 不应变化");

      const entries = readText(llmLog).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(
        entries.some((entry) => entry.probeHit === true),
        "被补齐的边界消息（RETAINED-ONE）必须进入送给模型的归并输入",
      );
      assert.equal(total.liveIncluded, true, "补齐历史的同时仍要纳入未压缩内容");
    });
  });

  await test("resolveCurrentSession：显式 / 环境变量 / 最近更新，拒绝子代理与跨工作区", async () => {
    const fixture = writeFixture("resolver.json", fixtureResolver());
    await withEnv({ WTQ_TEST_FIXTURE: fixture }, async () => {
      const source = getSource("zcode");

      const explicit = resolveCurrentSession({ sessionId: "sess_resolver_a1", cwd: WS, source, env: {} });
      assert.equal(explicit.resolvedBy, "explicit");
      assert.equal(explicit.session.id, "sess_resolver_a1");
      assert.equal(norm(explicit.cwd), norm(WS));

      assert.throws(
        () => resolveCurrentSession({ sessionId: "sess_resolver_c3", cwd: WS, source, env: {} }),
        /不属于当前工作区/,
        "显式指定别的 workspace 的会话必须拒绝",
      );
      assert.throws(
        () => resolveCurrentSession({ sessionId: "sess_subagent_x", source, env: {} }),
        /主会话/,
        "子代理会话必须拒绝",
      );

      const byEnv = resolveCurrentSession({ cwd: WS, source, env: { ZCODE_SESSION_ID: "sess_resolver_a1" } });
      assert.equal(byEnv.resolvedBy, "environment");
      assert.equal(byEnv.session.id, "sess_resolver_a1");

      const byClaudeEnv = resolveCurrentSession({ cwd: WS, source, env: { CLAUDE_SESSION_ID: "sess_resolver_a1" } });
      assert.equal(byClaudeEnv.resolvedBy, "environment");
      assert.equal(byClaudeEnv.session.id, "sess_resolver_a1");

      const envWrongCwd = resolveCurrentSession({ cwd: WS, source, env: { ZCODE_SESSION_ID: "sess_resolver_c3" } });
      assert.equal(envWrongCwd.resolvedBy, "latest-updated", "环境变量指向别的工作区时应回退到最近会话");
      assert.equal(envWrongCwd.session.id, "sess_resolver_b2");

      const envSubagent = resolveCurrentSession({ cwd: WS, source, env: { ZCODE_SESSION_ID: "sess_subagent_x" } });
      assert.equal(envSubagent.resolvedBy, "latest-updated");

      const latest = resolveCurrentSession({ cwd: WS, source, env: {} });
      assert.equal(latest.resolvedBy, "latest-updated");
      assert.equal(latest.session.id, "sess_resolver_b2", "应选工作区内 updatedAt 最新的主会话（排除子代理）");

      assert.throws(() => resolveCurrentSession({ cwd: WS3, source, env: {} }), /还没有可交接的对话/);
    });
  });

  await test("saveRaw=false 的历史段摘要缺失：数据库恢复并写修复摘要，不改写旧文件", async () => {
    const sid = "sess_degraded_c1";
    const fixture = writeFixture("degraded.json", fixtureTwoSegs(sid));
    const cfg = cfgFor("core-degraded", { saveRaw: false });
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const session = getSource("zcode").getSession(sid);
      const paths = store.sessionPaths(WS, session, cfg);

      // 前置：不调模型也不存原文（模拟当时模型全失败又没留 raw）→ 段文件停在"仅保留原文"的降级态
      const scanned = await scanSession(sid, { cwd: WS, cfg, summarize: false });
      assert.equal(scanned.newCount, 2);
      assert.deepEqual(scanned.errors, []);
      assert.ok(!exists(paths.rawDir), "saveRaw=false 时不应创建 raw/ 目录");
      const files = store.listChunkFiles(paths.dir);
      assert.equal(files.length, 2);
      for (const file of files) assert.match(readText(join(paths.dir, file)), /_摘要生成失败，本段仅保留原文。_/);
      const before = files.map((f) => readText(join(paths.dir, f)));

      const llmLog = join(TMP_ROOT, "llm-degraded.jsonl");
      const total = await withEnv({ WTQ_TEST_LLM_LOG: llmLog, WTQ_TEST_LLM_PROBE: "OLD-THREE" }, () =>
        buildTotal({ sessionOrId: sid, cwd: WS, cfg }),
      );

      assert.equal(total.chunkCount, 3, "两段历史 + 当前未压缩内容");
      assert.equal(total.liveIncluded, true);
      for (const file of files) {
        const repair = store.readRepair(paths, file);
        assert.ok(repair?.text?.includes("FIXTURE-CHUNK"), "数据库恢复的内容应重新生成摘要并保存修复文件");
        assert.equal(repair.sourceHash, store.sha256(readText(join(paths.dir, file))));
      }
      assert.ok(!total.warnings.some((w) => w.includes("摘要修复失败")), "模型正常时历史段修复应成功");
      assert.ok(
        !total.warnings.some((w) => w.includes("已改用原文归并")),
        "raw/ 不存在，不应误报成用原文归并",
      );
      assert.ok(exists(total.path), "恢复成功必须能生成交接文档");
      assert.match(readText(total.path), /live_included: true/);
      assert.ok(!exists(paths.rawDir), "整轮交接都不应因为恢复而写出 raw/ 文件");

      // 被压缩掉的原文必须重新进入归并输入（officialSummary 里没有 OLD-THREE，只能是数据库恢复）
      const entries = readText(llmLog).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(entries.some((entry) => entry.probeHit === true), "恢复出来的原文必须进入送给模型的归并输入");

      // 恢复只发生在内存里：旧段文件保持降级原文，不被"顺手修好"
      assert.deepEqual(
        files.map((f) => readText(join(paths.dir, f))),
        before,
        "历史段文件不应被改写",
      );
    });
  });

  await test("cwd 与会话工作区不一致：scanSession/buildTotal 拒绝写入（同工作区写法差异仍接受）", async () => {
    const sid = "sess_cwdmismatch_d1";
    const fixture = writeFixture("cwd-mismatch.json", fixtureTwoSegs(sid));
    const cfg = cfgFor("core-cwd-mismatch");
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const session = getSource("zcode").getSession(sid);
      const paths = store.sessionPaths(WS, session, cfg);
      assert.ok(!exists(paths.dir), "前置：该会话尚未归档");

      await assert.rejects(scanSession(sid, { cwd: WS2, cfg }), /归档工作区与会话不一致/);
      await assert.rejects(buildTotal({ sessionOrId: sid, cwd: WS2, cfg }), /归档工作区与会话不一致/);
      assert.ok(!exists(paths.dir), "被拒绝的写入不得留下任何归档目录");
      assert.ok(!exists(paths.total), "被拒绝的写入不得产生交接文档");
      assert.ok(!exists(store.sessionPaths(WS2, session, cfg).dir), "也不得写到错误工作区");

      // 大小写/结尾分隔符差异仍视为同一工作区，且写入落在 session.cwd 对应的目录
      const variant = process.platform === "win32" ? `${WS.toUpperCase()}\\` : `${WS}/`;
      const ok = await scanSession(sid, { cwd: variant, cfg, summarize: false });
      assert.equal(ok.newCount, 2);
      assert.equal(norm(ok.paths.dir), norm(paths.dir), "归档目录必须由 session.cwd 推导，而不是调用方传的 cwd");
      assert.ok(exists(paths.meta), "应写入 meta.json");
    });
  });

  await test("归档期间发生新压缩：活跃区间沿用扫描快照，不丢中间消息、新边界留待下次扫描", async () => {
    const sid = "sess_snapshot_live1";
    const fixture = writeFixture("snapshot-live.json", fixtureTwoSegs(sid));
    const cfg = cfgFor("core-snapshot-live");
    const llmLog = join(TMP_ROOT, "llm-snapshot-live.jsonl");
    await withEnv(
      { WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok", WTQ_TEST_LLM_DELAY_MS: "1200", WTQ_TEST_LLM_LOG: llmLog, WTQ_TEST_LLM_PROBE: "RETAINED-TWO" },
      async () => {
        const paths = store.sessionPaths(WS, getSource("zcode").getSession(sid), cfg);
        const pending = buildTotal({ sessionOrId: sid, cwd: WS, cfg });
        // 第一次段摘要返回时，listCompactions 快照已经取过，正处在后续段摘要/活跃段的窗口里
        await waitFor(
          () => (exists(llmLog) && readText(llmLog).trim().split("\n").filter(Boolean).length >= 1 ? true : null),
          30000,
          40,
        );
        const fx = JSON.parse(readText(fixture));
        fx.compactions[sid].push({
          boundaryId: "b3",
          time: iso(T0 + 9_000_000),
          startedAt: iso(T0 + 8_900_000),
          trigger: "auto",
          phase: "main",
          tailSequence: 9, // 新压缩把 sequence 8 也吞掉了：正是最容易被"顺移"丢掉的边界消息
          preCompactTokenCount: 3000,
          postCompactTokenCount: 400,
          summarizedMessageCount: 12,
          keptMessageCount: 2,
          summaryMessageIds: [],
          officialSummary: null,
        });
        fx.messages[sid].push(msgRow(sid, 11, "assistant_response", "AFTER-COMPACT-11 新压缩之后的内容"));
        writeFileSync(fixture, JSON.stringify(fx, null, 2) + "\n", "utf8");

        const total = await pending;
        const live = readText(paths.live);
        assert.match(
          live,
          /message_range: 8\.\.11/,
          "活跃区间必须从扫描快照的上一个尾巴（8）开始，而不是新压缩的尾巴（9）",
        );
        assert.equal(total.throughSequence, 11, "交接应覆盖到生成时刻的最新 sequence");
        // 摘要正文在 LIVE.md，活跃段原文在 raw/LIVE.md
        assert.match(readText(join(paths.rawDir, "LIVE.md")), /RETAINED-TWO/);
        assert.match(readText(join(paths.rawDir, "LIVE.md")), /AFTER-COMPACT-11/);

        const entries = readText(llmLog).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(entries.at(-1).kind, "total", "最后一次调用应是归并");
        assert.deepEqual(
          entries.map((e) => e.probeHit),
          [false, false, true, false],
          "两段历史摘要不含该消息；活跃段摘要（快照区间 8..11）必须含；归并只接收摘要正文，所以不再出现",
        );

        const state = JSON.parse(readText(paths.state));
        assert.ok(!state.processed.includes("b3"), "运行期间新出现的压缩边界应留待下一次扫描归档");
        assert.equal(state.chunkIndex, 2);

        // 下一次扫描补上 b3：它正好覆盖被新压缩吞掉的那条消息
        const second = await scanSession(sid, { cwd: WS, cfg });
        assert.equal(second.newCount, 1);
        const files = store.listChunkFiles(paths.dir);
        assert.deepEqual(files.map((f) => Number(f.split("-")[0])), [1, 2, 3]);
        const chunk3 = readText(join(paths.dir, files[2]));
        assert.match(chunk3, /boundary_id: "b3"/);
        assert.match(chunk3, /message_range: "8\.\.8"/, "b3 吞掉的区间应恰好是被快照区间覆盖过的 sequence 8");
        assert.match(readText(join(paths.rawDir, files[2])), /RETAINED-TWO/, "补扫段应包含该消息原文");
        assert.equal(JSON.parse(readText(paths.state)).chunkIndex, 3);
      },
    );
  });

  await test("连续同尾压缩（区间为空）：只记幂等、不占段号、不写空段文件", async () => {
    const sid = "sess_equaltail_e1";
    const fixture = writeFixture("equaltail.json", fixtureEqualTail(sid));
    const cfg = cfgFor("core-equaltail");
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const first = await scanSession(sid, { cwd: WS, cfg, summarize: true });
      assert.equal(first.newCount, 2, "只有 b1 与 b4 产生了真正的区间");
      assert.deepEqual(first.errors, []);
      const files = store.listChunkFiles(first.paths.dir);
      assert.deepEqual(files.map((f) => Number(f.split("-")[0])), [1, 2], "同尾边界不得占用段号");
      assert.equal(first.chunks[0].boundaryId, "b1");
      assert.equal(first.chunks[1].boundaryId, "b4");
      assert.equal(first.chunks[0].rows, 3, "第一段应是 sequence 1..3");
      assert.equal(first.chunks[1].rows, 3, "第二段应从 b3 的尾巴（4）到 b4 的尾巴（7）之前的 4..6");
      assert.match(readText(join(first.paths.dir, files[1])), /chunk: 2\b/, "段号必须连续，不能因为跳过而错位");
      assert.match(readText(join(first.paths.dir, files[1])), /message_range: "4\.\.6"/);

      const state = JSON.parse(readText(first.paths.state));
      assert.equal(state.chunkIndex, 2, "跳过的边界不得推进 chunkIndex");
      assert.deepEqual(state.processed, ["b1", "b2", "b3", "b4"], "同尾边界仍要记入幂等集合");
      assert.equal(JSON.parse(readText(first.paths.state)).processed.length, 4);

      const again = await scanSession(sid, { cwd: WS, cfg });
      assert.equal(again.newCount, 0, "重复扫描不得因为同尾边界而反复写文件");
      assert.deepEqual(store.listChunkFiles(again.paths.dir), files);
    });
  });

  await test("105 段归档：段文件、索引与归并输入按数字序号排序（非字典序）", async () => {
    const sid = "sess_bigsort_f1";
    const fixture = writeFixture("bigsort.json", fixtureBigSort(sid));
    const cfg = cfgFor("core-bigsort");
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const session = getSource("zcode").getSession(sid);
      const paths = store.sessionPaths(WS, session, cfg);
      mkdirSync(paths.dir, { recursive: true });
      for (let i = 1; i <= 105; i++) {
        store.writeChunk(
          paths,
          chunkFilename(i, iso(T0 + i * 60_000)),
          ["---", `session: "${sid}"`, `chunk: ${i}`, `boundary_id: "big-${i}"`, `message_range: "${i}..${i}"`, "---", "", "## 归档摘要", "", `BIG-MARK-${i} 第 ${i} 段摘要正文`, ""].join("\n"),
        );
      }
      const expected = Array.from({ length: 105 }, (_, i) => i + 1);
      const files = store.listChunkFiles(paths.dir);
      assert.equal(files.length, 105);
      assert.equal(files[0].split("-")[0], "01");
      assert.equal(files[104].split("-")[0], "105");
      assert.deepEqual(files.map((f) => Number(f.split("-")[0])), expected, "段文件必须按数字序号升序");
      assert.notDeepEqual(files, [...files].sort(), "用例前提：这个规模下数字序与字典序确实不同");

      store.writeState(paths, { processed: expected.map((i) => `big-${i}`), chunkIndex: 105, liveThroughSequence: null, liveBoundaryId: null });
      store.writeMeta(paths, session);
      const row = store.rebuildIndex(paths.root).sessions.find((s) => s.sessionId === sid);
      assert.equal(row?.chunkCount, 105);
      assert.deepEqual(row.chunks.map((c) => Number(c.file.split("-")[0])), expected, "索引也要按数字序号排序");
      assert.deepEqual(store.listChunks(paths).map((i) => i.file), files, "段清单顺序应与段文件一致");

      const llmLog = join(TMP_ROOT, "llm-bigsort.jsonl");
      const total = await withEnv({ WTQ_TEST_LLM_LOG: llmLog, WTQ_TEST_LLM_PROBE: "BIG-MARK-105" }, () =>
        buildTotal({ sessionOrId: sid, cwd: WS, cfg }),
      );
      assert.equal(total.chunkCount, 106, "105 段 + 当前未压缩内容");
      assert.match(readText(total.path), /chunk_count: 106/);
      const entries = readText(llmLog).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(entries.some((entry) => entry.probeHit === true), "排序末尾的第 105 段也必须进入归并输入");
    });
  });
}

/* ==================== 6. jobs：单飞 / 状态 / worker 子进程 ==================== */

async function jobsTests() {
  section("jobs：任务单飞与 worker 完成状态");

  await test("claimJob/updateJob/finishJob：独占锁、错误 jobId 拒绝、完成后可再次认领", async () => {
    const cfg = cfgFor("jobs-basic");
    const sid = "sess_jobs_basic";
    const first = jobs.claimJob(sid, { mode: "prepare-switch", cwd: WS });
    assert.ok(first?.jobId, "第一次 claim 应成功");
    assert.equal(first.status, "queued");
    assert.equal(first.finishedAt, null, "排队时不应写 finishedAt");

    assert.equal(jobs.claimJob(sid, { mode: "prepare-switch", cwd: WS }), null, "运行期间再次 claim 必须失败（单飞）");
    assert.equal(jobs.isRunning(sid), true);
    assert.equal(jobs.updateJob(sid, "not-the-job-id", { status: "running" }), null, "错误 jobId 不允许改状态");

    const running = jobs.updateJob(sid, first.jobId, { status: "running", phase: "archive" });
    assert.equal(running.status, "running");

    const done = jobs.finishJob(sid, first.jobId, { status: "done", phase: "done", durationMs: 1234 });
    assert.equal(done.status, "done");
    assert.equal(done.durationMs, 1234);
    assert.ok(done.finishedAt && Number.isFinite(Date.parse(done.finishedAt)), "完成时必须写 finishedAt");
    assert.ok(!existsSync(join(jobs.JOBS_DIR, `${sid}.lock`)), "完成后应释放独占锁");
    assert.equal(jobs.isRunning(sid), false);

    const second = jobs.claimJob(sid, { mode: "prepare-switch", cwd: WS });
    assert.ok(second?.jobId && second.jobId !== first.jobId, "完成后可以重新认领，且是新 jobId");
    jobs.finishJob(sid, second.jobId, { status: "done", durationMs: 0 });

    jobs.clearJob(sid);
    assert.equal(jobs.readJob(sid).status, "idle", "clearJob 应把非运行任务标成 idle");
  });

  await test("readJob：进程已死/超时的 running 任务标记 stale，活跃任务不被误判", async () => {
    const sid = "sess_jobs_stale";
    mkdirSync(jobs.JOBS_DIR, { recursive: true });
    const file = join(jobs.JOBS_DIR, `${sid}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        jobId: "stale-job",
        sessionId: sid,
        status: "running",
        mode: "prepare-switch",
        pid: 999999999,
        startedAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const stale = jobs.readJob(sid);
    assert.equal(stale.status, "stale");
    assert.ok(stale.error);
    assert.equal(jobs.isRunning(sid), false, "stale 不算运行中");

    writeFileSync(
      file,
      JSON.stringify({
        jobId: "live-job",
        sessionId: sid,
        status: "running",
        mode: "prepare-switch",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    assert.equal(jobs.readJob(sid).status, "running", "进程活着且未超时的任务不能被误判 stale");
    unlinkSync(file);
  });

  await test("startWorker：运行中返回 existing，完成后 job 记录 finishedAt/durationMs/total", async () => {
    if (!preloadInherits) {
      skip("worker 完成态", "子进程无法继承 test-preload，跳过以免触发真实模型调用");
      return;
    }
    const sid = "sess_worker_ok1";
    const fixture = writeFixture("worker-ok.json", fixtureLiveOnly(sid, "worker 完成态会话"));
    const cfg = cfgFor("jobs-worker-ok");
    await withEnv(
      {
        WTQ_TEST_FIXTURE: fixture,
        WTQ_OUTPUT_ROOT: cfg.outputRoot,
        WTQ_TEST_LLM_MODE: "ok",
        WTQ_TEST_LLM_DELAY_MS: "700",
      },
      async () => {
        const started = await jobs.startWorker(sid, WS, "prepare-switch");
        assert.equal(started.existing, false);
        assert.ok(started.job?.jobId);

        const again = await jobs.startWorker(sid, WS, "prepare-switch");
        assert.equal(again.existing, true, "worker 运行期间再次启动应返回 existing（不重复起进程）");
        assert.equal(again.job.jobId, started.job.jobId);

        const done = await waitFor(
          () => {
            const j = jobs.readJob(sid);
            return j && (j.status === "done" || j.status === "error") ? j : null;
          },
          90000,
          250,
        );
        assert.equal(done.status, "done", `worker 失败：${redact(done.error ?? "(无详情)")}`);
        assert.ok(done.finishedAt && Number.isFinite(Date.parse(done.finishedAt)), "完成时间必须是真实完成时刻");
        assert.ok(Number.isFinite(done.durationMs) && done.durationMs >= 300, `durationMs 应覆盖实际执行：${done.durationMs}`);
        assert.equal(done.mode, "prepare-switch");
        assert.equal(done.total?.liveIncluded, true);
        assert.ok(done.total?.path && exists(done.total.path));
        assert.match(readText(done.total.path), /FIXTURE-OVERVIEW/);
      },
    );
  });

  await test("startWorker：模型全失败时 job 完成并带机械 fallback", async () => {
    if (!preloadInherits) {
      skip("worker 失败态", "子进程无法继承 test-preload，跳过以免触发真实模型调用");
      return;
    }
    const sid = "sess_worker_err1";
    const fixture = writeFixture("worker-err.json", fixtureLiveOnly(sid, "worker 失败态会话"));
    const cfg = cfgFor("jobs-worker-err");
    await withEnv(
      {
        WTQ_TEST_FIXTURE: fixture,
        WTQ_OUTPUT_ROOT: cfg.outputRoot,
        WTQ_TEST_LLM_MODE: "fail",
        WTQ_TEST_LLM_DELAY_MS: "0",
      },
      async () => {
        await jobs.startWorker(sid, WS, "prepare-switch");
        const settled = await waitFor(
          () => {
            const j = jobs.readJob(sid);
            return j && (j.status === "done" || j.status === "error") ? j : null;
          },
          90000,
          250,
        );
        assert.equal(settled.status, "done", `模型失败应产出 fallback：${redact(settled.error ?? "(无详情)")}`);
        assert.equal(settled.error ?? null, null);
        assert.equal(settled.total?.isFallback, true);
        assert.match(String(settled.total?.fallbackReason), /所有可用的模型都调用失败/);
        assert.ok(settled.finishedAt, "完成也要写 finishedAt");
        assert.ok(Number.isFinite(settled.durationMs) && settled.durationMs >= 0);
        assert.ok(settled.total?.path && exists(settled.total.path));
        assert.match(readText(settled.total.path), /fallback: true/);
      },
    );
  });

  await test("startWorker：scan 运行中请求交接只挂 prepareRequested，scan 结束后自动接续 prepare-switch", async () => {
    if (!preloadInherits) {
      skip("scan→prepare 接续", "子进程无法继承 test-preload，跳过以免触发真实模型调用");
      return;
    }
    const sid = "sess_worker_chain1";
    const fixture = writeFixture("worker-chain.json", fixtureChain(sid));
    const cfg = cfgFor("jobs-worker-chain");
    await withEnv(
      {
        WTQ_TEST_FIXTURE: fixture,
        WTQ_OUTPUT_ROOT: cfg.outputRoot,
        WTQ_TEST_LLM_MODE: "ok",
        WTQ_TEST_LLM_DELAY_MS: "600", // 段摘要/总摘要各慢 600ms，保证 scan 运行期间能发出交接请求
      },
      async () => {
        const scan = await jobs.startWorker(sid, WS, "scan");
        assert.equal(scan.existing, false);

        const chained = await jobs.startWorker(sid, WS, "prepare-switch");
        assert.equal(chained.existing, true, "scan 运行中不允许并行起第二个任务");
        assert.equal(chained.job?.mode, "scan");
        assert.equal(chained.job?.prepareRequested, true, "应把交接意图挂在 scan 任务上");

        const done = await waitFor(
          () => {
            const j = jobs.readJob(sid);
            return j && j.mode === "prepare-switch" && (j.status === "done" || j.status === "error") ? j : null;
          },
          120000,
          300,
        );
        assert.equal(done.status, "done", `接续交接失败：${redact(done.error ?? "(无详情)")}`);
        assert.ok(done.total?.path && exists(done.total.path), "接续后应产出交接文档");
        assert.match(readText(done.total.path), /FIXTURE-OVERVIEW/);
        assert.ok(Number.isFinite(done.durationMs) && done.durationMs >= 0);
        assert.ok(!done.prepareRequested, "接续出来的新任务不应再带 prepareRequested");
      },
    );
  });

  await test("claimJob：新近损坏的锁不被抢占（即使上次任务已 done）；超龄锁才可回收", async () => {
    const sid = "sess_jobs_badlock1";
    mkdirSync(jobs.JOBS_DIR, { recursive: true });
    const first = jobs.claimJob(sid, { mode: "scan", cwd: WS });
    assert.ok(first?.jobId, "第一次 claim 应成功");
    jobs.finishJob(sid, first.jobId, { status: "done", phase: "done", durationMs: 5 });
    assert.equal(jobs.readJob(sid).status, "done");

    const lock = join(jobs.JOBS_DIR, `${sid}.json.lock`);
    writeFileSync(lock, '{"jobId":"trunc', "utf8"); // 写了一半 / 损坏的锁：既读不出 jobId，也不能当成"没有任务"
    const recent = new Date();
    utimesSync(lock, recent, recent);

    assert.equal(
      jobs.claimJob(sid, { mode: "scan", cwd: WS }),
      null,
      "损坏但很新的锁必须视为有任务正在进行（上次任务 done 也不行，避免两个 worker 同时写）",
    );
    assert.ok(exists(lock), "新近的锁文件不得被删除");
    assert.equal(jobs.readJob(sid).status, "done", "不得因为抢占而改写上次任务记录");
    assert.equal(jobs.isRunning(sid), false, "done 任务本身不算运行中");

    // 超过 2h TTL 的坏锁是彻底无主的，可以回收
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(lock, stale, stale);
    const reclaimed = jobs.claimJob(sid, { mode: "scan", cwd: WS });
    assert.ok(reclaimed?.jobId && reclaimed.jobId !== first.jobId, "超龄锁应可回收并开始新任务");
    assert.equal(reclaimed.status, "queued");
    jobs.finishJob(sid, reclaimed.jobId, { status: "done", durationMs: 0 });
  });

  await test("startWorker：锁与 job 记录 jobId 不一致时有限重试后报错，不覆盖运行中的任务", async () => {
    const sid = "sess_jobs_retry1";
    mkdirSync(jobs.JOBS_DIR, { recursive: true });
    const jobFile = join(jobs.JOBS_DIR, `${sid}.json`);
    const lock = join(jobs.JOBS_DIR, `${sid}.json.lock`);
    const now = new Date().toISOString();
    writeFileSync(
      jobFile,
      JSON.stringify({ jobId: "job-scan", sessionId: sid, status: "running", mode: "scan", phase: "archive", pid: process.pid, startedAt: now, updatedAt: now, prepareRequested: false }),
    );
    // 锁属于另一个 jobId（状态记录被抢占/写乱），updateJob 会拒绝写入
    writeFileSync(lock, JSON.stringify({ jobId: "job-other", pid: process.pid, startedAt: now }));

    await assert.rejects(
      jobs.startWorker(sid, WS, "prepare-switch", "explicit"),
      /后台任务状态正在变化/,
      "挂接续意图失败时必须有限重试后报错，而不是无限递归或静默丢任务",
    );
    const after = jobs.readJob(sid);
    assert.equal(after.jobId, "job-scan", "不得覆盖正在运行的 scan 任务记录");
    assert.equal(after.status, "running");
    assert.ok(!after.prepareRequested, "接续意图没挂上就不应留下半截状态");

    unlinkSync(lock);
    unlinkSync(jobFile);
  });
}

/* ==================== 7. prepare：核心 prepareSwitch ==================== */

async function prepareTests() {
  section("prepare：prepareSwitch 自动解析与强制纳入 LIVE");

  await test("prepareSwitch：无参数自动挑最近会话，且强制纳入未压缩内容（覆盖 cfg.skipLiveForTotal）", async () => {
    const fixture = writeFixture("prepare.json", fixtureResolver());
    const cfg = cfgFor("prepare-auto", { skipLiveForTotal: true }); // 故意传 true，prepareSwitch 必须强制为 false
    await withEnv({ WTQ_TEST_FIXTURE: fixture }, async () => {
      const total = await prepareSwitch({ cwd: WS, cfg });
      assert.equal(total.resolvedBy, "latest-updated");
      assert.equal(total.sessionId, "sess_resolver_b2");
      assert.equal(total.liveIncluded, true, "即使用户配置想跳过，交接也必须带上未压缩内容");
      assert.match(readText(total.path), /FIXTURE-OVERVIEW/);
      assert.match(total.handoverText, /TOTAL\.md/);

      const session = getSource("zcode").getSession("sess_resolver_b2");
      const paths = store.sessionPaths(WS, session, cfg);
      assert.ok(exists(paths.live), "应生成 LIVE.md");

      const job = jobs.readJob("sess_resolver_b2");
      assert.equal(job.status, "done");
      assert.equal(job.mode, "prepare-switch");
      assert.ok(Number.isFinite(job.durationMs) && job.durationMs >= 0);
      assert.ok(job.finishedAt);
      assert.equal(job.total?.path, total.path);
      assert.equal(job.total?.resolvedBy, "latest-updated");
    });
  });

  await test("prepareSwitch：显式 sessionId 优先于环境变量", async () => {
    const fixture = writeFixture("prepare-explicit.json", fixtureResolver());
    const cfg = cfgFor("prepare-explicit");
    await withEnv(
      { WTQ_TEST_FIXTURE: fixture, ZCODE_SESSION_ID: "sess_resolver_b2" },
      async () => {
        const total = await prepareSwitch({ sessionId: "sess_resolver_a1", cwd: WS, cfg });
        assert.equal(total.resolvedBy, "explicit");
        assert.equal(total.sessionId, "sess_resolver_a1");
        assert.match(readText(total.path), /session: "sess_resolver_a1"/);
      },
    );
  });

  await test("prepareSwitch：环境变量注入的宿主会话被采用", async () => {
    const fixture = writeFixture("prepare-env.json", fixtureResolver());
    const cfg = cfgFor("prepare-env");
    await withEnv(
      { WTQ_TEST_FIXTURE: fixture, ZCODE_SESSION_ID: "sess_resolver_d4" },
      async () => {
        const total = await prepareSwitch({ cwd: WS, cfg });
        assert.equal(total.resolvedBy, "environment");
        assert.equal(total.sessionId, "sess_resolver_d4");
      },
    );
  });

  await test("prepareSwitch：已有后台任务时拒绝启动（单飞）", async () => {
    const fixture = writeFixture("prepare-busy.json", fixtureResolver());
    const cfg = cfgFor("prepare-busy");
    const sid = "sess_resolver_b2";
    await withEnv({ WTQ_TEST_FIXTURE: fixture }, async () => {
      const held = jobs.claimJob(sid, { mode: "prepare-switch", cwd: WS });
      try {
        await assert.rejects(prepareSwitch({ sessionId: sid, cwd: WS, cfg }), /后台任务正在进行/);
      } finally {
        jobs.finishJob(sid, held.jobId, { status: "error", error: "test cleanup", durationMs: 0 });
      }
    });
  });

  await test("prepareSwitch：失败时返回机械 fallback，job 正常完成", async () => {
    const fixture = writeFixture("prepare-fail.json", fixtureResolver());
    const cfg = cfgFor("prepare-fail");
    const sid = "sess_resolver_d4";
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "fail" }, async () => {
      const total = await prepareSwitch({ sessionId: sid, cwd: WS, cfg });
      assert.equal(total.isFallback, true);
      assert.equal(total.isDraft, false);
      assert.equal(total.model, null);
      assert.match(String(total.fallbackReason), /所有可用的模型都调用失败/);
      assert.ok(total.warnings.some((w) => w.includes("机械拼接版")));
      assert.ok(total.path && exists(total.path));

      const job = jobs.readJob(sid);
      assert.equal(job.status, "done");
      assert.equal(job.total?.isFallback, true);
      assert.equal(job.error ?? null, null);
      assert.ok(job.finishedAt);
      assert.ok(Number.isFinite(job.durationMs));
    });
  });
}

/* ==================== 8. mcp：JSON-RPC 工具契约 ==================== */

function startMcp(envPatch = {}) {
  const child = spawn(process.execPath, ["--import", pathToFileURL(PRELOAD_PATH).href, MCP_PATH], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...envPatch },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const malformed = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        malformed.push(line.slice(0, 160));
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const settle = pending.get(msg.id);
        pending.delete(msg.id);
        settle(msg);
      }
    }
  });

  const rpc = (method, params) =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} 响应超时；stderr=${redact(stderr).slice(0, 300)}`));
      }, 30000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  return {
    child,
    rpc,
    malformed,
    stderrText: () => stderr,
    async stop() {
      try {
        child.stdin.end();
      } catch {
        /* 忽略 */
      }
      await Promise.race([once(child, "close"), sleep(8000)]);
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    },
  };
}

async function mcpTests() {
  section("mcp：JSON-RPC 工具契约（prepare_switch / list_sessions）");

  await test("tools/list：prepare_switch 参数全可选，open_panel 带 cwd/sessionId，保留旧别名", async () => {
    const fixture = writeFixture("mcp.json", fixtureResolver());
    const env = { WTQ_TEST_FIXTURE: fixture, WTQ_OUTPUT_ROOT: join(OUT_ROOT, "mcp"), ZCODE_PROJECT_DIR: WS };
    const mcp = startMcp(env);
    try {
      const init = await mcp.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tests.handoff", version: "1.0.0" },
      });
      assert.equal(init.result?.serverInfo?.name, "wutongqie");
      assert.ok(init.result?.capabilities?.tools);

      const list = await mcp.rpc("tools/list", {});
      const tools = list.result?.tools ?? [];
      const byName = new Map(tools.map((t) => [t.name, t]));
      assert.ok(byName.has("prepare_switch"), "必须有 prepare_switch");
      assert.ok(byName.has("build_total_summary"), "必须保留 build_total_summary 兼容别名");
      assert.ok(byName.has("open_panel"), "必须保留 open_panel");

      const ps = byName.get("prepare_switch");
      assert.deepEqual(Object.keys(ps.inputSchema.properties).sort(), ["cwd", "sessionId"]);
      assert.ok(!ps.inputSchema.required || ps.inputSchema.required.length === 0, "prepare_switch 所有参数可选");
      assert.match(ps.description, /交接|准备切换/, "工具描述应指向交接主流程");

      const op = byName.get("open_panel");
      assert.ok(op.inputSchema.properties.cwd, "open_panel 应接受 cwd");
      assert.ok(op.inputSchema.properties.sessionId, "open_panel 应接受 sessionId");

      assert.equal(mcp.malformed.length, 0, `stdout 出现非 JSON-RPC 输出：${mcp.malformed.join(" | ")}`);
    } finally {
      await mcp.stop();
    }
  });

  await test("tools/call：prepare_switch 立即返回草稿，后台完成后缓存最终版；别名同源", async () => {
    const fixture = writeFixture("mcp-call.json", fixtureResolver());
    const env = {
      WTQ_TEST_FIXTURE: fixture,
      WTQ_OUTPUT_ROOT: join(OUT_ROOT, "mcp-call"),
      ZCODE_PROJECT_DIR: WS,
      WTQ_TEST_LLM_MODE: "ok",
      WTQ_TEST_LLM_DELAY_MS: "250",
    };
    const mcp = startMcp(env);
    try {
      await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

      const call = await mcp.rpc("tools/call", { name: "prepare_switch", arguments: {} });
      const res = call.result;
      assert.ok(res && !res.isError, `prepare_switch 不应失败：${redact(res?.content?.[0]?.text ?? "")}`);
      const sc = res.structuredContent;
      assert.ok(sc, "应返回 structuredContent（交接结果对象）");
      assert.equal(sc.sessionId, "sess_resolver_b2", "无参数时应自动选中最近会话");
      assert.equal(sc.resolvedBy, "latest-updated");
      assert.ok(["queued", "running"].includes(sc.status), `首次请求应立即返回 queued/running，实际为 ${sc.status}`);
      assert.equal(sc.background, true);
      assert.ok(sc.jobId, "首次请求应返回后台 jobId");
      assert.ok(sc.draft?.isDraft, "首次请求应返回可复制草稿");
      assert.equal(sc.handover, null, "草稿阶段不应把 draft 冒充最终 handover");
      assert.equal(sc.draft.path, sc.path, "草稿路径应与统一 TOTAL.md 路径一致");
      assert.equal(sc.liveIncluded, true);
      assert.match(sc.draft.handoverText, /TOTAL\.md/);

      const text = res.content?.[0]?.text ?? "";
      assert.match(text, /交接请求已返回/);
      assert.ok(text.includes(sc.path), "人类可读文本应带交接文档路径");
      assert.ok(text.includes(sc.draft.handoverText), "人类可读文本应带可复制的新会话提示");
      assert.match(text, /后台/);
      assert.ok(!text.includes("keyHint"), "不应把供应商密钥提示混进工具输出");

      const cached = await waitFor(
        async () => {
          const next = await mcp.rpc("tools/call", { name: "prepare_switch", arguments: {} });
          const candidate = next.result?.structuredContent;
          return candidate?.status === "cached" ? candidate : null;
        },
        90000,
        400,
      );
      assert.equal(cached.reused, true, "后台完成后再次请求应复用最终交接");
      assert.equal(cached.background, false);
      assert.equal(cached.draft, null);
      assert.match(cached.handover?.highlights?.overview ?? "", /FIXTURE-OVERVIEW/);
      assert.match(cached.handover?.highlights?.conclusions ?? "", /FIXTURE-CONCLUSION/);
      assert.match(cached.handover?.highlights?.constraints ?? "", /FIXTURE-CONSTRAINT/);
      assert.match(cached.handoverText, /TOTAL\.md/);

      const legacy = await mcp.rpc("tools/call", { name: "build_total_summary", arguments: {} });
      const legacySc = legacy.result?.structuredContent;
      assert.equal(legacySc?.status, "cached", "旧别名应沿用同一缓存行为");
      assert.equal(legacySc?.path, cached.path, "旧别名应返回同一交接路径");
      assert.match(legacySc?.handover?.highlights?.overview ?? "", /FIXTURE-OVERVIEW/);
      assert.match(legacy.result.content?.[0]?.text ?? "", /交接/);

      const unknown = await mcp.rpc("tools/call", { name: "not_a_tool", arguments: {} });
      assert.equal(unknown.result?.isError, true, "未知工具应返回可纠正的错误而不是崩溃");

      const mismatch = await mcp.rpc("tools/call", {
        name: "prepare_switch",
        arguments: { sessionId: "sess_resolver_c3", cwd: WS },
      });
      assert.equal(mismatch.result?.isError, true, "跨工作区显式会话应报错");
      assert.match(mismatch.result?.content?.[0]?.text ?? "", /执行失败|不属于当前工作区/);

      assert.equal(mcp.malformed.length, 0, `stdout 出现非 JSON-RPC 输出：${mcp.malformed.join(" | ")}`);
    } finally {
      await mcp.stop();
    }
  });

  await test("tools/call list_sessions：真实执行，标注归档进度与运行中的后台任务", async () => {
    const sid = "sess_mcp_list1";
    const busySid = "sess_mcp_list2";
    const base = fixtureTwoSegs(sid);
    const busy = fixtureLiveOnly(busySid, "后台任务会话");
    busy.compactions[busySid] = [
      {
        boundaryId: "mcp-busy-b1",
        time: iso(T0 + 5_000_000),
        startedAt: iso(T0 + 4_900_000),
        trigger: "auto",
        phase: "main",
        tailSequence: 4,
        preCompactTokenCount: 500,
        postCompactTokenCount: 100,
        summarizedMessageCount: 8,
        keptMessageCount: 2,
        summaryMessageIds: [],
        officialSummary: null,
      },
    ];
    const cfg = cfgFor("mcp-list");
    const fixture = writeFixture("mcp-list.json", {
      sessions: [...base.sessions, ...busy.sessions],
      messages: { ...base.messages, ...busy.messages },
      compactions: { ...base.compactions, ...busy.compactions },
    });
    await withEnv({ WTQ_TEST_FIXTURE: fixture, WTQ_TEST_LLM_MODE: "ok" }, async () => {
      const scanned = await scanSession(sid, { cwd: WS, cfg });
      assert.equal(scanned.newCount, 2, "前置：先把 2 个压缩段归档好");
    });

    const held = jobs.claimJob(busySid, { mode: "scan", cwd: WS });
    assert.ok(held?.jobId, "前置：给第二个会话挂一个运行中的后台任务");
    assert.equal(jobs.isRunning(busySid), true);

    const mcp = startMcp({ WTQ_TEST_FIXTURE: fixture, WTQ_OUTPUT_ROOT: cfg.outputRoot, ZCODE_PROJECT_DIR: WS });
    try {
      await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
      const call = await mcp.rpc("tools/call", { name: "list_sessions", arguments: { cwd: WS } });
      const res = call.result;
      assert.ok(res && !res.isError, `list_sessions 不应失败：${redact(res?.content?.[0]?.text ?? "")}`);
      const text = res.content?.[0]?.text ?? "";
      assert.match(text, /归档根目录：/);

      const row1 = text.split("\n").find((line) => line.startsWith(sid));
      assert.ok(row1, `list_sessions 应列出 ${sid}：${text}`);
      assert.match(row1, /\| 2 \| 2 \| 0 \| 无 \|/, "2 个压缩边界、已归档 2 段、无待归档、还没有交接文档");
      assert.ok(!row1.includes("后台任务运行中"), "没有后台任务的会话不应被标注");

      const row2 = text.split("\n").find((line) => line.startsWith(busySid));
      assert.ok(row2, `list_sessions 应列出 ${busySid}：${text}`);
      assert.match(row2, /\| 1 \| 0 \| 1 \| 无 \|/, "1 个压缩边界、尚未归档");
      assert.match(row2, /\[后台任务运行中\]/, "运行中的后台任务必须标注（isRunning 分支）");

      assert.equal(mcp.malformed.length, 0, `stdout 出现非 JSON-RPC 输出：${mcp.malformed.join(" | ")}`);
    } finally {
      jobs.finishJob(busySid, held.jobId, { status: "done", durationMs: 0 });
      await mcp.stop();
    }
  });
}

/* ==================== 9. panel：本地网页面板契约（等待面板重写合入后生效） ==================== */

const panelsToKill = new Set();

function killPanelPids() {
  for (const pid of panelsToKill) {
    try {
      process.kill(pid);
    } catch {
      /* 已退出 */
    }
  }
  panelsToKill.clear();
}

async function http(port, path, { method = "GET", token, body, timeoutMs = 30000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { "X-WTQ-Token": token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, text, json, contentType: res.headers.get("content-type") ?? "" };
}

function ensurePanelCode(cwd, sessionId) {
  return [
    `const { ensurePanel } = await import(${JSON.stringify(PANEL_LIB_URL)});`,
    `const info = await ensurePanel({ cwd: ${JSON.stringify(cwd)}, sessionId: ${JSON.stringify(sessionId)} });`,
    `process.stdout.write(JSON.stringify({`,
    `  port: info.port, pid: info.pid, cwd: info.cwd ?? null, sessionId: info.sessionId ?? null,`,
    `  reused: Boolean(info.reused), version: info.version ?? null,`,
    `}) + "\\n");`,
  ].join("\n");
}

async function ensurePanelOnce({ cwd, sessionId, envPatch = {} }) {
  const r = await runNode(["--input-type=module", "-e", ensurePanelCode(cwd, sessionId)], { envPatch, timeoutMs: 90000 });
  assert.equal(r.code, 0, `ensurePanel 子进程失败：${redact(r.stderr).slice(0, 500)}`);
  const last = r.stdout.trim().split("\n").filter(Boolean).pop();
  const info = JSON.parse(last);
  if (info.pid) panelsToKill.add(info.pid);
  return info;
}

/** 新版面板按工作区写 panel-<sha256前16位>.json，这里按 cwd 找它。 */
function panelInfoFilesFor(cwd) {
  return readdirSync(PLUGIN_DATA)
    .filter((name) => /^panel-[0-9a-f]{16}\.json$/.test(name))
    .filter((name) => {
      try {
        return norm(JSON.parse(readText(join(PLUGIN_DATA, name))).cwd) === norm(cwd);
      } catch {
        return false;
      }
    });
}

async function panelTests() {
  section("panel：网页面板端到端（依赖面板重写已合入）");

  if (!preloadInherits) {
    skip("面板全部用例", "子进程无法继承 test-preload，跳过以免面板任务触发真实模型调用");
    return;
  }

  await test("ensurePanel + HTTP 契约：ping/静态资源/token/state/prepare-switch 全流程", async () => {
    const fixture = writeFixture("panel.json", fixtureResolver());
    const foreignPath = join(OUT_ROOT, "panel-previous-root", "TOTAL.md");
    mkdirSync(dirname(foreignPath), { recursive: true });
    writeFileSync(foreignPath, "FOREIGN-HANDOVER\n", "utf8");
    const foreign = { path: foreignPath, totalPath: foreignPath, handoverText: "FOREIGN-HANDOVER" };
    jobs.writeJob("sess_resolver_b2", {
      status: "done", mode: "prepare-switch", cwd: WS,
      total: foreign, handover: foreign, draft: { ...foreign, isDraft: true },
    });
    const outDir = join(OUT_ROOT, "panel");
    const env = { WTQ_TEST_FIXTURE: fixture, WTQ_OUTPUT_ROOT: outDir, ZCODE_PROJECT_DIR: WS, WTQ_TEST_LLM_MODE: "ok", WTQ_TEST_LLM_DELAY_MS: "700" };
    const B = "sess_resolver_b2";
    try {
      const info = await ensurePanelOnce({ cwd: WS, sessionId: B, envPatch: env });
      assert.ok(info.port > 0 && info.pid > 0, "ensurePanel 应返回端口和 pid");
      assert.equal(info.reused, false, "首次启动不应是复用");

      const panelFile = JSON.parse(readText(join(PLUGIN_DATA, "panel.json")));
      assert.equal(norm(panelFile.cwd), norm(WS), "panel.json 应绑定工作区");
      assert.equal(panelFile.sessionId, B, "panel.json 应记录打开时的会话");
      assert.ok(Number.isFinite(panelFile.version) && panelFile.version >= 1, "panel.json 应带面板版本号");
      assert.equal(panelFile.pid, info.pid);

      const ping = await http(info.port, "/api/ping");
      assert.equal(ping.status, 200);
      assert.equal(ping.json?.pid, info.pid);
      assert.equal(ping.json?.cwd, WS);
      assert.equal(ping.json?.sessionId, B);

      const lucide = await http(info.port, "/lucide.min.js");
      assert.equal(lucide.status, 200, "/lucide.min.js 必须免 token 公开");
      assert.match(lucide.contentType, /javascript/);
      assert.ok(lucide.text.length > 50);

      const html = await http(info.port, "/");
      assert.equal(html.status, 200);
      assert.match(html.text, /window\.__WTQ_TOKEN\s*=/);
      assert.match(html.text, /window\.__WTQ_SESSION_ID\s*=/);
      assert.ok(!html.text.includes("__WTQ_TOKEN__"), "token 占位符必须被真实值替换");
      assert.ok(html.text.includes(B), "HTML 应注入绑定会话 id");
      const tokenMatch = html.text.match(/window\.__WTQ_TOKEN\s*=\s*"([^"]+)"/);
      assert.ok(tokenMatch?.[1] && tokenMatch[1] !== "__WTQ_TOKEN__", "HTML 里应内嵌真实 token");
      const TOKEN = tokenMatch[1];

      const noToken = await http(info.port, "/api/state");
      assert.equal(noToken.status, 403, "业务 API 必须校验 token");
      const badToken = await http(info.port, "/api/state", { token: "not-the-token" });
      assert.equal(badToken.status, 403);

      const stateRes = await http(info.port, `/api/state?sessionId=${encodeURIComponent(B)}&cwd=${encodeURIComponent(WS)}`, { token: TOKEN });
      assert.equal(stateRes.status, 200);
      const st = stateRes.json;
      assert.equal(st?.current?.sessionId, B);
      assert.equal(st?.current?.resolvedBy, "explicit", "显式 sessionId 应标记 explicit");
      assert.ok(Array.isArray(st?.choices) && st.choices.some((c) => c.sessionId === B), "choices 应含当前可选会话");
      assert.ok(!st.choices.some((c) => String(c.sessionId).startsWith("sess_subagent_")), "choices 不应含子代理会话");
      assert.ok(st?.root, "state 应带归档根目录");
      assert.equal(st?.current?.handover ?? null, null, "初始不应有交接结果");
      assert.equal(st?.current?.draft ?? null, null, "不能展示其他归档根目录的草稿");
      assert.ok(!JSON.stringify(st).includes("FOREIGN-HANDOVER"), "state 的所有任务展示入口都应过滤旧根目录产物");
      const snapshot = await http(info.port, `/api/job?sessionId=${B}`, { token: TOKEN });
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.json?.handover, null);
      assert.equal(snapshot.json?.draft, null);
      assert.ok(!JSON.stringify(snapshot.json).includes("FOREIGN-HANDOVER"), "轻量轮询不能泄漏旧产物");
      assert.equal(readText(foreignPath), "FOREIGN-HANDOVER\n", "过滤展示不得改写已有归档");
      assert.ok(Array.isArray(st?.providers) && st.providers.length >= 1);

      const t0 = Date.now();
      const post = await http(info.port, "/api/prepare-switch", {
        method: "POST",
        token: TOKEN,
        body: { sessionId: B, cwd: WS },
      });
      const elapsed = Date.now() - t0;
      assert.ok([200, 202].includes(post.status), `POST 应返回 200/202（实际 ${post.status}）`);
      assert.equal(post.json?.ok, true);
      assert.equal(post.json?.sessionId, B);
      assert.ok(post.json?.job && typeof post.json.job === "object", "POST 应立刻返回 job 状态");
      assert.ok(elapsed < 2000, `/api/prepare-switch 应立即返回（实际 ${elapsed}ms），长任务交给 worker`);
      assert.equal(post.json?.draft?.isDraft, true);
      assert.ok(exists(post.json.draft.path));
      assert.equal(post.json?.handover ?? null, null);
      const running = await http(info.port, `/api/job?sessionId=${B}`, { token: TOKEN });
      assert.ok(["queued", "running"].includes(running.json?.job?.status));
      assert.equal(running.json?.draft?.isDraft, true);
      assert.equal(running.json?.handover, null, "草稿不能被当作旧版最终交接展示");

      const finished = await waitFor(
        async () => {
          const r = await http(info.port, `/api/state?sessionId=${encodeURIComponent(B)}`, { token: TOKEN });
          const j = r.json?.current?.job;
          if (!j) return null;
          return j.status === "done" || j.status === "error" ? { job: j, state: r.json } : null;
        },
        90000,
        400,
      );
      assert.equal(finished.job.status, "done", `面板任务失败：${redact(finished.job.error ?? "(无详情)")}`);
      assert.ok(finished.job.total?.path && exists(finished.job.total.path), "job.total.path 应指向落盘的交接文档");
      assert.match(readText(finished.job.total.path), /FIXTURE-OVERVIEW/);
      assert.ok(Number.isFinite(finished.job.durationMs) && finished.job.durationMs >= 0, "job 应记录耗时");
      assert.ok(finished.job.finishedAt, "job 应记录完成时间");

      const handover = finished.state?.current?.handover;
      assert.equal(handover?.path, finished.job.total.path, "state 应回传最近一次交接结果");
      assert.match(handover?.highlights?.overview ?? "", /FIXTURE-OVERVIEW/);
      assert.equal(handover?.liveIncluded, true);
      assert.match(handover?.handoverText ?? "", /TOTAL\.md/);
      assert.equal(finished.state?.current?.stale, false, "刚生成的交接不应是落后状态");

      // 不传 sessionId 时应回退到面板绑定的当前会话；内容未变化时直接复用 final。
      const post2 = await http(info.port, "/api/prepare-switch", { method: "POST", token: TOKEN, body: { cwd: WS } });
      assert.equal(post2.status, 200, `缓存命中应返回 200（实际 ${post2.status}）`);
      assert.equal(post2.json?.ok, true);
      assert.equal(post2.json?.sessionId, B, "不传 sessionId 时应使用面板绑定的会话");
      assert.equal(post2.json?.status, "cached", "没有新内容时应直接复用最终交接");
      assert.equal(post2.json?.reused, true);
      assert.equal(post2.json?.background, false);
      assert.equal(post2.json?.job, null, "缓存命中不应再次启动后台任务");
      assert.equal(post2.json?.handover?.path, finished.job.total.path);
      assert.match(post2.json?.handover?.highlights?.overview ?? "", /FIXTURE-OVERVIEW/);
    } finally {
      killPanelPids();
    }
  });

  await test("ensurePanel：同工作区复用、换工作区不复用、版本不匹配不复用", async () => {
    const fixture = writeFixture("panel-reuse.json", fixtureResolver());
    const env = { WTQ_TEST_FIXTURE: fixture, WTQ_OUTPUT_ROOT: join(OUT_ROOT, "panel-reuse"), ZCODE_PROJECT_DIR: WS };
    const B = "sess_resolver_b2";
    const C = "sess_resolver_c3";
    try {
      const a = await ensurePanelOnce({ cwd: WS, sessionId: B, envPatch: env });
      const b = await ensurePanelOnce({ cwd: WS, sessionId: null, envPatch: env });
      assert.equal(b.reused, true, "同工作区应复用已有面板");
      assert.equal(b.pid, a.pid);
      assert.equal(b.port, a.port);

      const c = await ensurePanelOnce({ cwd: WS2, sessionId: C, envPatch: env });
      assert.equal(c.reused, false, "不同工作区绝不能复用旧面板");
      assert.notEqual(c.pid, a.pid);
      assert.equal((await http(c.port, "/api/ping")).json?.cwd, WS2);
      assert.equal((await http(c.port, "/api/ping")).json?.sessionId, C);
      assert.equal((await http(a.port, "/api/ping")).json?.cwd, WS, "旧面板不受影响");

      // 面板进程活着，但按工作区记录的 panel-*.json 版本落后 → 必须视为不可复用
      const perCwd = panelInfoFilesFor(WS2);
      assert.ok(perCwd.length >= 1, "应写入按工作区的 panel-<hash>.json");
      const live = JSON.parse(readText(join(PLUGIN_DATA, perCwd[0])));
      assert.equal(live.version, 3, "panel.json 应带当前面板版本号");
      writeFileSync(join(PLUGIN_DATA, perCwd[0]), JSON.stringify({ ...live, version: 2 }, null, 2) + "\n", "utf8");
      writeFileSync(join(PLUGIN_DATA, "panel.json"), JSON.stringify({ ...live, version: 2 }, null, 2) + "\n", "utf8");
      const d = await ensurePanelOnce({ cwd: WS2, sessionId: C, envPatch: env });
      assert.equal(d.reused, false, "版本不匹配时不应复用旧面板");
      assert.notEqual(d.pid, c.pid);
      const pingD = await http(d.port, "/api/ping");
      assert.equal(pingD.status, 200);
      assert.equal(pingD.json?.sessionId, C);
    } finally {
      killPanelPids();
    }
  });

  await test("runServer：直接以 (cwd, sessionId) 启动，ping 能读到绑定信息", async () => {
    const fixture = writeFixture("panel-runserver.json", fixtureResolver());
    const env = { WTQ_TEST_FIXTURE: fixture, WTQ_OUTPUT_ROOT: join(OUT_ROOT, "panel-runserver"), ZCODE_PROJECT_DIR: WS };
    const C = "sess_resolver_c3";
    const code = [
      `const { runServer } = await import(${JSON.stringify(PANEL_LIB_URL)});`,
      `runServer(${JSON.stringify(WS2)}, ${JSON.stringify(C)});`,
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid) panelsToKill.add(child.pid);
    try {
      const info = await waitFor(
        () => {
          const file = join(PLUGIN_DATA, "panel.json");
          if (!exists(file)) return null;
          const parsed = JSON.parse(readText(file));
          return parsed.pid === child.pid ? parsed : null;
        },
        30000,
        200,
      );
      const ping = await http(info.port, "/api/ping");
      assert.equal(ping.status, 200);
      assert.equal(ping.json?.cwd, WS2);
      assert.equal(ping.json?.sessionId, C);
    } finally {
      killPanelPids();
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }
  });

  await test("MCP open_panel：cwd/sessionId 透传到面板进程", async () => {
    const fixture = writeFixture("panel-mcp.json", fixtureResolver());
    const env = {
      WTQ_TEST_FIXTURE: fixture,
      WTQ_OUTPUT_ROOT: join(OUT_ROOT, "panel-mcp"),
      ZCODE_PROJECT_DIR: WS,
      WTQ_TEST_LLM_MODE: "ok",
    };
    const B = "sess_resolver_b2";
    const mcp = startMcp(env);
    try {
      const init = await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
      assert.equal(init.result?.serverInfo?.name, "wutongqie");
      const call = await mcp.rpc("tools/call", { name: "open_panel", arguments: { cwd: WS, sessionId: B } });
      assert.ok(!call.result?.isError, `open_panel 失败：${redact(call.result?.content?.[0]?.text ?? "")}`);
      const text = call.result.content?.[0]?.text ?? "";
      assert.match(text, /127\.0\.0\.1:\d+/);

      const panelFile = JSON.parse(readText(join(PLUGIN_DATA, "panel.json")));
      if (panelFile.pid) panelsToKill.add(panelFile.pid);
      assert.equal(norm(panelFile.cwd), norm(WS));
      assert.equal(panelFile.sessionId, B, "open_panel 应把当前会话一起传给面板");
      const ping = await http(panelFile.port, "/api/ping");
      assert.equal(ping.json?.cwd, WS);
      assert.equal(ping.json?.sessionId, B);
    } finally {
      await mcp.stop();
      killPanelPids();
    }
  });
}

/* ==================== 10. 运行与收尾 ==================== */

if (flag("list")) {
  console.log(`可用区块: ${ALL_SECTIONS.join(", ")}`);
  process.exit(0);
}

console.log(`无痛切交接链路测试 · ${RUN_ID}`);
console.log(`临时目录: ${TMP_ROOT}`);
console.log(`区块: ${SECTIONS.join(", ")}`);

try {
  if (want("core")) await coreTests();
  if (want("jobs")) await jobsTests();
  if (want("prepare")) await prepareTests();
  if (want("mcp")) await mcpTests();
  if (want("panel")) await panelTests();
} catch (err) {
  FAILED.push({ section: CURRENT_SECTION, name: "(运行器异常)", message: redact(err?.stack ?? err) });
  console.error(`\n运行器异常: ${redact(err?.stack ?? err)}`);
}

killPanelPids();

console.log("\n=========== 汇总 ===========");
console.log(`通过 ${PASS.length} 项，失败 ${FAILED.length} 项，跳过 ${SKIPPED.length} 项`);
if (FAILED.length) {
  console.log("\n失败明细：");
  for (const f of FAILED) {
    console.log(`  x [${f.section}] ${f.name}`);
    for (const line of String(f.message).split("\n").slice(0, 8)) console.log(`      ${line}`);
  }
}
if (SKIPPED.length) {
  console.log("\n跳过明细：");
  for (const s of SKIPPED) console.log(`  - [${s.section}] ${s.name}：${s.reason}`);
}
if (COVERAGE) {
  console.log("\n覆盖清单：");
  let sectionName = "";
  for (const t of PASS) {
    if (t.section !== sectionName) {
      sectionName = t.section;
      console.log(`  [${sectionName}]`);
    }
    console.log(`    · ${t.name}`);
  }
}

if (!KEEP) {
  let removed = !existsSync(TMP_ROOT);
  let lastError = "";
  for (let attempt = 0; !removed && attempt < 2; attempt++) {
    try {
      rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (err) {
      lastError = `${err?.code ?? "?"} ${String(err?.path ?? "")}`;
    }
    removed = !existsSync(TMP_ROOT);
    if (!removed) {
      // 某些 Windows/沙箱环境下 fs.rmSync 会静默不删；cmd rmdir 是可靠兜底。
      const fallback = spawnSync("cmd", ["/c", "rmdir", "/s", "/q", TMP_ROOT], { stdio: "ignore" });
      if (fallback.error) lastError = lastError || String(fallback.error.message);
      removed = !existsSync(TMP_ROOT);
    }
    if (!removed) await sleep(250);
  }
  if (removed) {
    try {
      rmdirSync(dirname(TMP_ROOT)); // 只在没有其他 run 目录时才会成功
    } catch {
      /* 其他并发 run 的目录仍在，保留父目录 */
    }
    console.log(`\n临时目录已清理: ${TMP_ROOT}`);
  } else {
    console.log(`\n⚠ 临时目录未能自动清理（${lastError || "仍有占用"}），可手动删除: ${TMP_ROOT}`);
  }
} else {
  console.log(`\n临时目录保留: ${TMP_ROOT}`);
}

process.exit(FAILED.length ? 1 : 0);
