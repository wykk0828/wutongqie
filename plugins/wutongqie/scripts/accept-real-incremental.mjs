// 无痛切 1.2.0「真实模型增量验收」：只用**完全合成**的对话，走真实 provider 调用，
// 验证 reused 快路径、rolling merge 只提交增量、旧段原文不再外发。
//
//   node plugins/wutongqie/scripts/accept-real-incremental.mjs
//
// 设计约束（与真实模型验收脚本的安全约定一致，但数据完全不同）：
//   · 不读真实会话 db：registerSource() 顶替 id="zcode" 的会话源，全部数据来自合成 fixture；
//   · 不安装 fetch mock：真实调用本机配置里可用的 provider（优先 deepseek 系列，否则第一个可用）；
//     fetch 只加一层「记录请求正文」的包壳，用于断言，再原样转发，不改写任何请求；
//   · 密钥与请求头绝不落盘、绝不打印：记录里只有 messages 正文、模型名、状态码与耗时，
//     不含 headers/Authorization；provider 配置只读。
//   · outputRoot 与 ZCODE_PLUGIN_DATA 都隔离到 <项目>/.zcode/tests/real-incremental-<runId>/，
//     archive.log.jsonl 等日志也只落在这里。
//   · 全程数据为虚构内容，报告只写布尔值与长度，不写正文。
//
// 三轮验收：
//   R1 首轮全量：种子段(固定摘要) + 合成 LIVE → 真实模型生成 TOTAL（必须成功，非机械 fallback）；
//   R2 内容无变化：命中 reused，模型调用 0 次、TOTAL 不重写；
//   R3 增加合成段与新 LIVE：rolling=true、passes=1、归并调用恰好 1 次；
//      请求包含上一版正文/新增段/最新 LIVE，且不包含旧段原文与旧段文件的额外副本。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ==================== 0. 隔离目录与环境（必须在导入核心模块之前） ==================== */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..", "..");
const PLUGIN_DIR = join(PROJECT_ROOT, "plugins", "wutongqie");

const RUN_ID = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${process.pid}`;
const TMP_ROOT = join(PROJECT_ROOT, ".zcode", "tests", `real-incremental-${RUN_ID}`);
const WS = join(TMP_ROOT, "workspace");
const OUT_ROOT = join(TMP_ROOT, "output");
const PLUGIN_DATA = join(TMP_ROOT, "plugin-data");
const FIXTURE = join(TMP_ROOT, "fixture.json");
const REPORT_JSON = join(TMP_ROOT, "acceptance-incremental.json");
const REPORT_MD = join(TMP_ROOT, "report.md");

const STAGE_EXIT = { setup: 2, fixture: 3, provider: 4, build: 5, assert: 6 };
const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;
const log = (...args) => console.log(`[+${String(elapsed()).padStart(6)}ms]`, ...args);

{
  const low = (p) => resolve(p).toLowerCase();
  assert.ok(low(TMP_ROOT).startsWith(low(PROJECT_ROOT)), `临时目录必须在项目内: ${TMP_ROOT}`);
  assert.ok(!low(TMP_ROOT).includes(low(join(PROJECT_ROOT, ".无痛切"))), "临时目录不得靠近真实归档目录");
}
for (const dir of [TMP_ROOT, WS, OUT_ROOT, PLUGIN_DATA]) mkdirSync(dir, { recursive: true });

// 隔离：插件数据目录与归档根都指向本次运行目录；不设置 HOME（provider 配置需要只读真 HOME）。
process.env.ZCODE_PLUGIN_DATA = PLUGIN_DATA;
process.env.WTQ_OUTPUT_ROOT = OUT_ROOT;
delete process.env.WTQ_TEST_FIXTURE;
delete process.env.WTQ_TEST_PRELOAD;
delete process.env.ZCODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;

/* ==================== 1. 合成 fixture（虚构内容） ==================== */

const SID = "sess_incremental_synthetic_01";
const TITLE = "无痛切增量验收 · 合成对话";
const MOCK_NAME = "real-incremental synthetic source";
const T0 = Date.parse("2026-10-01T08:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const UID = Math.random().toString(16).slice(2, 10);
const OLD_RAW_SENTINEL = `OLDRAW-${UID}-MUST-NOT-LEAVE`;
const OLD_SUM_MARKER = `OLDSUM-${UID}`;

const msg = (seq, role, kind, text, time = T0 + seq * 60_000) => ({
  id: `${SID}_m${seq}`,
  sequence: seq,
  time,
  role,
  kind,
  text,
});

// seq 1..3 属于种子段（预先归档，原文永不进入模型调用）；
// seq 4..6 是 R1 的 LIVE；R3 追加 seq 7..9 与新边界 b2(tail=8)。
function initialFixture() {
  return {
    sessions: [{ id: SID, title: TITLE, cwd: WS, createdAt: iso(T0), updatedAt: iso(T0 + 9 * 60_000) }],
    messages: {
      [SID]: [
        msg(1, "user", "user_prompt", "合成任务：把导出报表的全量查询改为按日期区间查询，接口参数保持向后兼容。"),
        msg(2, "assistant", "assistant_response", `已定位到 src/report/export.mjs。内部跟踪串 ${OLD_RAW_SENTINEL} 仅用于夹具校验，请勿复述。`),
        msg(3, "user", "user_prompt", "好，先加可选参数，别动默认行为。"),
        msg(4, "assistant", "assistant_response", "已增加可选参数 dateFrom/dateTo，不传时行为与现在完全一致。"),
        msg(5, "user", "user_prompt", "补一组回归用例，覆盖不传参数和只传单边的情况。"),
        msg(6, "assistant", "assistant_response", "已补 3 个回归用例，本地命令 node --test 全绿。"),
      ],
    },
    compactions: {
      [SID]: [
        {
          boundaryId: "b1",
          time: iso(T0 + 3 * 60_000),
          startedAt: iso(T0 + 2 * 60_000),
          trigger: "auto",
          phase: "main",
          preCompactTokenCount: 12_000,
          postCompactTokenCount: 2_800,
          summarizedMessageCount: 3,
          keptMessageCount: 1,
          summaryMessageIds: [],
          officialSummary: null,
          tailSequence: 4,
        },
      ],
    },
  };
}

function readFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

function appendMessages(rows) {
  const fx = readFixture();
  fx.messages[SID] = [...(fx.messages[SID] ?? []), ...rows];
  fx.sessions[0].updatedAt = iso(T0 + 9 * 60_000);
  writeFileSync(FIXTURE, JSON.stringify(fx, null, 2) + "\n", "utf8");
}

function appendCompaction(boundary) {
  const fx = readFixture();
  fx.compactions[SID] = [...(fx.compactions[SID] ?? []), boundary];
  writeFileSync(FIXTURE, JSON.stringify(fx, null, 2) + "\n", "utf8");
}

/** 预先归档的种子段正文：固定摘要（含标记与一条长基准句）；文件在拿到真实 paths 后写入。 */
const SEEDED_BODY = [
  "# 1. 目标与意图",
  "把合成报表导出从全量查询改为按日期区间查询，且不破坏既有调用方。",
  "",
  "# 2. 已完成事项",
  "- 在 src/report/export.mjs 增加可选参数 dateFrom / dateTo，默认行为不变。",
  `- 固定摘要标记：${OLD_SUM_MARKER}。`,
  "",
  "# 3. 关键决策与理由",
  `- 合成基准句（旧段固定摘要，用于校验滚动归并没有重复提交整段历史）：${UID}-ALPHA-${UID}-BRAVO-${UID}-CHARLIE-${UID}-DELTA-${UID}-ECHO-${UID}-FOXTROT-${UID}-GOLF。`,
  "",
  "# 4. 产出文件与代码位置",
  "- src/report/export.mjs（合成路径，实际不存在）",
  "",
  "# 5. 未决问题",
  "- 无",
  "",
  "# 6. 用户偏好与硬约束",
  "- 默认行为不得变化。",
].join("\n");

/** 把种子段写成「已归档」状态：固定摘要文件 + state.processed，scan 不再摘要它、原文永不外发。 */
function seedArchivedChunk(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "01-20261001-0001.md");
  writeFileSync(
    file,
    [
      "---",
      `session: "${SID}"`,
      `session_title: "${TITLE}"`,
      `cwd: "${WS}"`,
      "chunk: 1",
      'boundary_id: "b1"',
      `message_range: "1..3"`,
      'summary_model: "fixture-seeded"',
      "---",
      "",
      `# 第 1/1 段归档摘要 · ${TITLE}`,
      "",
      "## 归档摘要",
      "",
      SEEDED_BODY,
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(dir, "state.json"), JSON.stringify({ processed: ["b1"], chunkIndex: 1 }, null, 2) + "\n", "utf8");
  return file;
}

/** mock 源：每次调用重读 fixture（追加即时生效）；绝不触碰真实 db.sqlite。 */
function createMockSource() {
  return {
    id: "zcode",
    name: MOCK_NAME,
    default: true,
    listSessions({ cwd, limit = 30 } = {}) {
      const fx = readFixture();
      return (fx.sessions ?? [])
        .filter((s) => !cwd || resolve(s.cwd).toLowerCase() === resolve(cwd).toLowerCase())
        .slice(0, limit)
        .map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, createdAt: s.createdAt, updatedAt: s.updatedAt }));
    },
    getSession(id) {
      const s = (readFixture().sessions ?? []).find((x) => x.id === id);
      return s ? { id: s.id, title: s.title, slug: null, cwd: s.cwd, createdAt: s.createdAt, updatedAt: s.updatedAt } : null;
    },
    maxSequence(id) {
      const seqs = (readFixture().messages?.[id] ?? []).map((m) => m.sequence);
      return seqs.length ? Math.max(...seqs) : -1;
    },
    listCompactions(id) {
      return (readFixture().compactions?.[id] ?? []).slice().sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    },
    getSegment(id, fromSeq, toSeq) {
      const rows = (readFixture().messages?.[id] ?? [])
        .filter((m) => m.sequence > fromSeq && m.sequence < toSeq)
        .sort((a, b) => a.sequence - b.sequence);
      const messages = rows.map((m) => ({
        id: m.id,
        sequence: m.sequence,
        time: typeof m.time === "string" ? Date.parse(m.time) : m.time,
        role: m.role,
        kind: m.kind,
        special: null,
        parts: [{ sequence: 1, data: { type: "text", text: String(m.text ?? "") } }],
      }));
      const userCount = rows.filter((m) => m.role === "user").length;
      const assistantCount = rows.filter((m) => m.role === "assistant").length;
      return {
        messages,
        stats: { fromSeq, toSeq, totalRows: rows.length, userCount, assistantCount, toolCount: 0, hiddenRows: 0 },
      };
    },
  };
}

writeFileSync(FIXTURE, JSON.stringify(initialFixture(), null, 2) + "\n", "utf8");

/* ==================== 2. 请求记录包壳（不装 mock，真实转发） ==================== */

if (globalThis.__WTQ_TEST_FETCH__) {
  console.error("检测到 test-preload 的 fetch 夹具仍在生效，会拦截真实模型调用，已中止。");
  process.exit(STAGE_EXIT.setup);
}
const realFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async function recordedFetch(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = String(init?.method ?? (typeof input === "object" && input?.method) ?? "GET").toUpperCase();
  let entry = null;
  if (method === "POST" && /\/chat\/completions(?:[?#]|$)/.test(url)) {
    let payload = {};
    try {
      payload = JSON.parse(init?.body ?? "{}");
    } catch {
      payload = {};
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const system = String(messages.find((m) => m?.role === "system")?.content ?? "");
    const text = messages.map((m) => String(m?.content ?? "")).join("\n");
    entry = {
      at: new Date().toISOString(),
      kind: /总对话摘要/.test(system) ? "total" : "chunk",
      isLive: /第 LIVE 段/.test(text),
      model: String(payload.model ?? ""),
      chars: text.length,
      text,
      status: null,
      ok: null,
      durationMs: null,
    };
    requests.push(entry);
  }
  const t = Date.now();
  try {
    const res = await realFetch.call(this, input, init);
    if (entry) {
      entry.status = res.status;
      entry.ok = res.ok;
    }
    return res;
  } finally {
    if (entry) entry.durationMs = Date.now() - t;
  }
};

/* ==================== 3. 加载核心模块 + 注册 mock 源 ==================== */

const sources = await import(pathToFileURL(join(PLUGIN_DIR, "core", "sources", "index.mjs")).href);
sources.registerSource(createMockSource());
const { buildTotal } = await import(pathToFileURL(join(PLUGIN_DIR, "core", "archive.mjs")).href);
const store = await import(pathToFileURL(join(PLUGIN_DIR, "core", "store.mjs")).href);
const llm = await import(pathToFileURL(join(PLUGIN_DIR, "core", "llm.mjs")).href);

assert.equal(sources.getSource("zcode").name, MOCK_NAME, "mock 源未生效（真实 db 源仍在）");

/* ==================== 4. provider：优先 deepseek 系列模型，否则取第一个可用 ==================== */

const allProviders = llm.listProviders();
const usable = allProviders.filter((p) => p.usable && p.enabled);
log(
  `providers  : ${allProviders.length} 个，可用且启用 ${usable.length} 个 -> ${usable.map((p) => p.name).join(", ") || "无"}`,
);
const preferred = usable.find((p) => /deepseek/i.test(p.name));
const provider = preferred ?? usable[0];
if (!provider) {
  console.error("没有可用的 openai-chat-completions provider，无法做真实模型验收。");
  process.exit(STAGE_EXIT.provider);
}
const modelId = provider.models?.includes("deepseek-flash") ? "deepseek-flash" : provider.models?.[0];
if (!modelId) {
  console.error(`provider ${provider.name} 没有配置模型。`);
  process.exit(STAGE_EXIT.provider);
}
const providerPlan = preferred ? "deepseek-preferred" : "default-first-usable";
log(`llm        : ${providerPlan} -> ${provider.name} / ${modelId}（baseUrl=${provider.baseUrl}，密钥不回显）`);

const cfg = {
  outputRoot: OUT_ROOT,
  saveRaw: true,
  announce: false,
  panelPort: 0,
  skipLiveForTotal: false,
  maxMessageChars: 4000,
  toolOutputPreview: 240,
  maxTranscriptChars: 60_000,
  mergeBudgetChars: 60_000,
  llmProviderId: provider.providerId,
  llmModelId: modelId,
  llmTimeoutMs: 120_000,
};

const paths = store.sessionPaths(WS, sources.getSource("zcode").getSession(SID), cfg);
const seededFile = seedArchivedChunk(paths.dir);
log(`seed       : ${seededFile}（种子段原文不参与任何模型调用）`);
const report = {
  ok: false,
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  stage: null,
  provider: { plan: providerPlan, providerId: provider.providerId, name: provider.name, modelId, baseUrl: provider.baseUrl },
  isolation: {
    tmpRoot: TMP_ROOT,
    outputRoot: OUT_ROOT,
    pluginData: PLUGIN_DATA,
    fixture: FIXTURE,
    realDbRead: false,
    sessionSource: MOCK_NAME,
  },
  paths: { dir: paths.dir, total: paths.total, live: paths.live, state: paths.state },
  markers: { oldRawSentinel: OLD_RAW_SENTINEL, oldSummaryMarker: OLD_SUM_MARKER },
  rounds: {},
  checks: {},
  requests: [],
};

/* ==================== 5. 三轮验收 ==================== */

const textOf = (entries) => entries.map((r) => r.text).join("\n");
const countOccurrences = (haystack, needle) => (needle ? haystack.split(needle).length - 1 : 0);
const mergeCalls = () => requests.filter((r) => r.kind === "total");
const liveCalls = () => requests.filter((r) => r.kind === "chunk" && r.isLive);
const chunkCalls = () => requests.filter((r) => r.kind === "chunk" && !r.isLive);

function windowFrom(text, min = 48) {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= min && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("---"));
  if (!lines.length) return null;
  return lines.sort((a, b) => b.length - a.length)[0].slice(0, 160);
}

const must = (cond, name, extra = "") => {
  report.checks[name] = Boolean(cond) ? extra || true : { pass: false, detail: extra };
  if (!cond) throw new Error(`断言失败：${name}${extra ? `（${extra}）` : ""}`);
};

async function main() {
  /* ---------- R1：首轮全量（种子段 + 合成 LIVE） ---------- */
  log("R1         : 首轮全量生成（真实模型，可能需要几十秒）");
  const t1 = Date.now();
  const r1 = await buildTotal({ sessionOrId: SID, cwd: WS, cfg, onProgress: ({ phase }) => log(`R1 phase   : ${phase}`) });
  const r1ms = Date.now() - t1;
  const r1Calls = requests.slice();
  log(`R1         : ${r1ms}ms rolling=${r1.rolling} passes=${r1.passes} fallback=${r1.isFallback} calls=${r1Calls.length}`);
  must(r1.isFallback === false, "r1_model_ok", `isFallback=${r1.isFallback}`);
  must(r1.rolling === false, "r1_full_build", `rolling=${r1.rolling}`);
  must(Boolean(r1.model), "r1_model_reported", String(r1.model ?? ""));
  must(r1.liveIncluded === true, "r1_live_included");
  must(r1Calls.length === 2, "r1_calls_expected", `calls=${r1Calls.length}（预计 1 次 LIVE 摘要 + 1 次归并）`);
  must(liveCalls().length === 1, "r1_one_live_call", `liveCalls=${liveCalls().length}`);
  must(mergeCalls().length === 1, "r1_one_merge_call", `mergeCalls=${mergeCalls().length}`);
  const r1Merge = mergeCalls()[0];
  must(r1Merge.ok === true, "r1_merge_http_ok", `status=${r1Merge.status}`);
  const oldSumWindow = windowFrom(SEEDED_BODY);
  must(Boolean(oldSumWindow), "r1_old_summary_window_found");
  must(
    r1Merge.text.includes(oldSumWindow),
    "r1_merge_includes_seeded_summary",
    `windowChars=${oldSumWindow?.length ?? 0}`,
  );

  const state1 = JSON.parse(readFileSync(paths.state, "utf8"));
  const prevBody = String(state1.rollingBase?.body ?? "");
  must(prevBody.trim().length > 0, "r1_rolling_base_saved", `chars=${prevBody.length}`);
  const prevWindow = windowFrom(prevBody);
  must(Boolean(prevWindow), "r1_prev_body_window_found");

  report.rounds.r1 = {
    elapsedMs: r1ms,
    rolling: r1.rolling,
    passes: r1.passes,
    isFallback: r1.isFallback,
    liveIncluded: r1.liveIncluded,
    model: r1.model,
    usage: r1.usage,
    calls: r1Calls.map((r) => ({ kind: r.kind, isLive: r.isLive, status: r.status, chars: r.chars, durationMs: r.durationMs })),
  };

  /* ---------- R2：无变化 → reused，0 次模型调用 ---------- */
  log("R2         : 内容无变化，应命中 reused 且不调模型");
  const callsBeforeR2 = requests.length;
  const mtimeBeforeR2 = statSync(paths.total).mtimeMs;
  const t2 = Date.now();
  const r2 = await buildTotal({ sessionOrId: SID, cwd: WS, cfg });
  const r2ms = Date.now() - t2;
  const r2NewCalls = requests.length - callsBeforeR2;
  must(r2.reused === true, "r2_reused", `reused=${r2.reused}`);
  must(r2NewCalls === 0, "r2_zero_model_calls", `newCalls=${r2NewCalls}`);
  must(statSync(paths.total).mtimeMs === mtimeBeforeR2, "r2_total_not_rewritten");
  log(`R2         : ${r2ms}ms reused=${r2.reused} newCalls=${r2NewCalls}`);
  report.rounds.r2 = { elapsedMs: r2ms, reused: r2.reused, throughSequence: r2.throughSequence ?? null, newCalls: r2NewCalls };

  /* ---------- R3：追加合成段 + 新 LIVE → rolling，1 次归并调用 ---------- */
  log("R3         : 追加合成压缩段与新的活跃消息");
  const NEW_CHUNK_SENTINEL = `NEWRAW-${UID}`;
  const NEW_LIVE_SENTINEL = `NEWLIVE-${UID}`;
  appendMessages([
    msg(7, "assistant", "assistant_response", `新增工作：把区间条件也用到缓存键上，合成标记 ${NEW_CHUNK_SENTINEL}。`),
    msg(8, "user", "user_prompt", `再确认一下：查询走索引，合成标记 ${NEW_LIVE_SENTINEL}。`),
    msg(9, "assistant", "assistant_response", "已确认走索引，等压测数据。"),
  ]);
  appendCompaction({
    boundaryId: "b2",
    time: iso(T0 + 9 * 60_000),
    startedAt: iso(T0 + 8 * 60_000),
    trigger: "auto",
    phase: "main",
    preCompactTokenCount: 15_000,
    postCompactTokenCount: 3_200,
    summarizedMessageCount: 4,
    keptMessageCount: 1,
    summaryMessageIds: [],
    officialSummary: null,
    tailSequence: 8,
  });

  const callsBeforeR3 = requests.length;
  const t3 = Date.now();
  const r3 = await buildTotal({ sessionOrId: SID, cwd: WS, cfg, onProgress: ({ phase }) => log(`R3 phase   : ${phase}`) });
  const r3ms = Date.now() - t3;
  const r3Calls = requests.slice(callsBeforeR3);
  log(
    `R3         : ${r3ms}ms rolling=${r3.rolling} passes=${r3.passes} fallback=${r3.isFallback} calls=${r3Calls.length} ` +
      `(${r3Calls.map((r) => `${r.kind}${r.isLive ? "-live" : ""}`).join(", ")})`,
  );
  must(r3.isFallback === false, "r3_model_ok", `isFallback=${r3.isFallback}`);
  must(r3.rolling === true, "r3_rolling_merge", `rolling=${r3.rolling}`);
  must(r3.passes === 1, "r3_single_merge_pass", `passes=${r3.passes}`);
  must(r3.usage?.calls === 1, "r3_usage_calls_one", `usage.calls=${r3.usage?.calls}`);
  must(r3Calls.length === 3, "r3_call_count_three", `calls=${r3Calls.length}: ${r3Calls.map((r) => r.kind).join(",")}`);
  must(r3Calls.filter((r) => r.kind === "chunk").length === 2, "r3_two_chunk_calls", `chunkCalls=${r3Calls.filter((r) => r.kind === "chunk").length}`);
  must(r3Calls.filter((r) => r.kind === "total").length === 1, "r3_one_merge_call");
  const r3Merge = r3Calls.find((r) => r.kind === "total");
  must(r3Merge.ok === true, "r3_merge_http_ok", `status=${r3Merge.status}`);

  // 新增段/LIVE 的原文只允许出现在本轮 chunk 调用里（这是首次归档它们，属于预期外发）
  const r3ChunkText = textOf(r3Calls.filter((r) => r.kind === "chunk"));
  must(r3ChunkText.includes(NEW_CHUNK_SENTINEL), "r3_new_chunk_raw_sent");
  must(r3ChunkText.includes(NEW_LIVE_SENTINEL), "r3_new_live_raw_sent");

  // 合并请求：必须带上一版正文 + 新增段摘要 + 最新 LIVE 摘要，且不得重复提交旧段内容
  const newChunkFile = readdirSync(paths.dir).filter((f) => /^\d{2,}-\d{8}-\d{4}\.md$/.test(f)).sort()[1];
  const newChunkText = extractBody(readFileSync(join(paths.dir, newChunkFile), "utf8"));
  const state3 = JSON.parse(readFileSync(paths.state, "utf8"));
  const newLiveText = String(state3.liveSummary?.text ?? "");
  const newChunkWindow = windowFrom(newChunkText);
  const newLiveWindow = windowFrom(newLiveText);
  must(Boolean(newChunkWindow), "r3_new_chunk_window_found", newChunkFile);
  must(Boolean(newLiveWindow), "r3_new_live_window_found");

  must(r3Merge.text.includes(prevWindow), "r3_includes_previous_body", `prevWindowChars=${prevWindow.length}`);
  must(r3Merge.text.includes(newChunkWindow), "r3_includes_new_chunk_summary");
  must(r3Merge.text.includes(newLiveWindow), "r3_includes_latest_live_summary");

  const allText = textOf(requests);
  must(!allText.includes(OLD_RAW_SENTINEL), "old_raw_never_sent", `sentinel=${OLD_RAW_SENTINEL}`);
  const oldSumExtra = countOccurrences(r3Merge.text, oldSumWindow) - countOccurrences(prevBody, oldSumWindow);
  must(oldSumExtra <= 0, "r3_no_extra_old_segment_copies", `extraOccurrences=${oldSumExtra}`);

  report.rounds.r3 = {
    elapsedMs: r3ms,
    rolling: r3.rolling,
    passes: r3.passes,
    isFallback: r3.isFallback,
    model: r3.model,
    usage: r3.usage,
    newChunkFile,
    calls: r3Calls.map((r) => ({ kind: r.kind, isLive: r.isLive, status: r.status, chars: r.chars, durationMs: r.durationMs })),
  };
  report.requestChecks = {
    totalRequests: requests.length,
    mergeRequests: mergeCalls().length,
    liveRequests: liveCalls().length,
    newChunkRequests: chunkCalls().length,
    oldRawSentinelEverSent: allText.includes(OLD_RAW_SENTINEL),
    oldSummaryMarkerInR1Merge: r1Merge.text.includes(OLD_SUM_MARKER),
    oldSummaryMarkerInR3Merge: r3Merge.text.includes(OLD_SUM_MARKER),
    previousBodyInR3Merge: r3Merge.text.includes(prevWindow),
    newChunkSummaryInR3Merge: r3Merge.text.includes(newChunkWindow),
    latestLiveSummaryInR3Merge: r3Merge.text.includes(newLiveWindow),
    extraOldSummaryCopiesInR3: oldSumExtra,
    rollingPromptChars: r3Merge.chars,
    previousBodyChars: prevBody.length,
  };

  /* ---------- 隔离证据：日志里没有对话正文 ---------- */
  const logFile = join(PLUGIN_DATA, "archive.log.jsonl");
  const logText = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  must(existsSync(logFile), "plugin_data_log_in_isolated_dir");
  must(
    !logText.includes(OLD_RAW_SENTINEL) && !logText.includes(NEW_CHUNK_SENTINEL) && !logText.includes(NEW_LIVE_SENTINEL),
    "plugin_data_log_without_bodies",
  );
  report.isolation.logFile = logFile;
  report.isolation.logHasConversationBodies = /OLDRAW-|NEWRAW-|NEWLIVE-/.test(logText);

  report.ok = true;
}

/* ==================== 6. 报告与退出 ==================== */

function extractBody(markdown) {
  const start = markdown.indexOf("\n## 归档摘要\n");
  let body = start >= 0 ? markdown.slice(start + "\n## 归档摘要\n".length) : markdown;
  const det = body.indexOf("\n<details>");
  if (det >= 0) body = body.slice(0, det);
  return body.trim();
}

function writeReport(err) {
  report.elapsedMs = elapsed();
  report.finishedAt = new Date().toISOString();
  if (err) {
    report.stage = err.stage ?? "build";
    report.error = String(err?.message ?? err);
    report.errorName = err?.name ?? null;
  }
  report.requests = requests.map((r) => ({
    at: r.at,
    kind: r.kind,
    isLive: r.isLive,
    model: r.model,
    status: r.status,
    ok: r.ok,
    chars: r.chars,
    durationMs: r.durationMs,
  }));
  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  const lines = [
    `# 无痛切真实模型增量验收（合成对话）`,
    "",
    `- 结果：${report.ok ? "通过" : `失败（stage=${report.stage}）`}`,
    `- runId：${report.runId}，总耗时 ${report.elapsedMs}ms`,
    `- provider：${report.provider.name} / ${report.provider.modelId}（${report.provider.plan}）`,
    `- 隔离目录：${TMP_ROOT}`,
    `- 请求总数：${requests.length}（merge ${mergeCalls().length} / live ${liveCalls().length} / chunk ${chunkCalls().length}）`,
    "",
    "## 轮次",
    "```json",
    JSON.stringify(report.rounds, null, 2),
    "```",
    "",
    "## 请求检查",
    "```json",
    JSON.stringify(report.requestChecks ?? {}, null, 2),
    "```",
    "",
    "## 断言",
    "```json",
    JSON.stringify(report.checks, null, 2),
    "```",
    err ? `\n## 错误\n\n\`\`\`\n${String(err?.stack ?? err).split("\n").slice(0, 15).join("\n")}\n\`\`\`` : "",
  ];
  writeFileSync(REPORT_MD, lines.join("\n") + "\n", "utf8");
}

main().then(
  () => {
    writeReport(null);
    console.log(`\nACCEPTANCE OK  报告: ${REPORT_JSON}`);
    console.log(
      JSON.stringify(
        {
          ok: true,
          elapsedMs: report.elapsedMs,
          provider: `${report.provider.name} / ${report.provider.modelId}`,
          r1: { ms: report.rounds.r1.elapsedMs, calls: report.rounds.r1.calls.length, usage: report.rounds.r1.usage },
          r2: { ms: report.rounds.r2.elapsedMs, reused: report.rounds.r2.reused, newCalls: report.rounds.r2.newCalls },
          r3: {
            ms: report.rounds.r3.elapsedMs,
            rolling: report.rounds.r3.rolling,
            passes: report.rounds.r3.passes,
            calls: report.rounds.r3.calls.length,
            usage: report.rounds.r3.usage,
          },
          requestChecks: report.requestChecks,
          report: REPORT_JSON,
        },
        null,
        2,
      ),
    );
    process.exitCode = 0;
  },
  (err) => {
    if (!err.stage) err.stage = "assert";
    writeReport(err);
    console.error(`\nACCEPTANCE FAILED [stage=${err.stage}] ${String(err?.message ?? err)}`);
    console.error(String(err?.stack ?? "").split("\n").slice(0, 10).join("\n"));
    console.error(JSON.stringify({ ok: false, stage: err.stage, error: String(err?.message ?? err), report: REPORT_JSON }, null, 2));
    process.exitCode = STAGE_EXIT[err.stage] ?? 9;
  },
);
