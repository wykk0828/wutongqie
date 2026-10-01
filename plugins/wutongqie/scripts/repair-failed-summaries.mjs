// 无痛切 · 真实修复已归档失败段（独立 sidecar 模式）
//
//   node plugins/wutongqie/scripts/repair-failed-summaries.mjs [选项]
//
// 选项：
//   --session <sess_xxx>       指定会话；默认解析 --cwd 下最近活动的主会话
//   --cwd <工作区路径>          默认当前目录（或 ZCODE_PROJECT_DIR）
//   --expect-failed <n>        期望的"失败段"数量（真实修复必填；先跑 --preflight 可查得）；
//                              数量不符时不写任何文件即退出（除非 --allow-count-mismatch）
//   --allow-count-mismatch     允许失败段数量与期望不符，继续执行
//   --label <名字>             附加到运行目录名，便于区分
//   --preflight                只做只读检查（解析会话、列出失败段与预算），不 claim job、不备份、不扫描
//   --help
//
// 行为约束（必须保持）：
//   · 只用主线 `scanSession(sessionId, { cwd, cfg, summarize: true, repairFailed: true })`；
//     绝不调用 buildTotal，绝不覆盖既有 TOTAL.md，只写 repairs/NN-*.md.json + 标准 scan 的
//     LIVE/state/meta/index 更新；provider / 用户 config 一律不改（不调用 saveConfig）。
//   · 真实 source 只读；真实 ZCODE_PLUGIN_DATA 与真实 job 锁保持原样（不重定向、不清理别人的锁）：
//     先 claim job（单飞）拿锁，运行中 heartbeat，结束只结束自己的 jobId，绝不清其他锁。
//   · 扫描前先把会话归档整体备份到 <项目>/.zcode/tests/repair-real-<runId>/backup/，
//     逐文件 sha256 清单（manifest.json）核验；扫描后逐文件比对新旧哈希：
//     LIVE/state/meta/index 的变化是标准 scan 允许的；原 chunk、既有 raw（LIVE.md 除外）、TOTAL 变化一律记为 violation。
//   · 不复制、不打印任何密钥/请求头/请求正文/响应正文/归档原文；stdout、report.md、report.json
//     只写元信息：provider 名与模型、失败文件名、修复段数与 sidecar size/passes/usage/模型、
//     逐文件哈希比对、max_tokens 预算。
//   · scan 期间出现新 boundary / 新 chunk 会记录并标记；新产生的失败不会被算进"修复成功"，
//     成功只按"本次目标失败段（--expect-failed 对应名单）的 repair sidecar 是否有效"统计。
//
// 退出码：0 正常；1 扫描失败或出现 violation / 仍有失败段；2 job 锁被占用（拒绝并发）；
//         3 失败段数量与 --expect-failed 不符；4 备份核验失败；64 参数错误。

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, PLUGIN_DATA } from "../core/config.mjs";
import { getSource } from "../core/sources/index.mjs";
import { resolveCurrentSession } from "../core/current-session.mjs";
import { scanSession } from "../core/archive.mjs";
import { claimJob, finishJob, readJob, updateJob } from "../core/jobs.mjs";
import { pickProvider } from "../core/llm.mjs";
import { extractSummary, failedSummary, validRepair } from "../core/chunk-input.mjs";
import { requestLimits } from "../core/budget.mjs";
import * as store from "../core/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..", "..");

/* ==================== 参数 ==================== */

function printHelp() {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 31).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

function parseArgs(argv) {
  const out = { session: "", cwd: "", expectFailed: null, label: "", preflight: false, allowCountMismatch: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--session") out.session = String(argv[++i] ?? "");
    else if (arg === "--cwd") out.cwd = String(argv[++i] ?? "");
    else if (arg === "--expect-failed") out.expectFailed = Number(argv[++i]);
    else if (arg === "--label") out.label = String(argv[++i] ?? "");
    else if (arg === "--preflight") out.preflight = true;
    else if (arg === "--allow-count-mismatch") out.allowCountMismatch = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}（--help 查看用法）`);
      process.exit(64);
    }
  }
  if (out.expectFailed !== null && (!Number.isFinite(out.expectFailed) || out.expectFailed < 0)) {
    console.error(`--expect-failed 需要非负整数，收到: ${out.expectFailed}`);
    process.exit(64);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* ==================== 工具 ==================== */

const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const rel = (from, to) => relative(from, to).split(sep).join("/");
const nowIso = () => new Date().toISOString();
const nf = (value) => (Number.isFinite(value) ? value : null);
const sum = (values) => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

function listFilesRecursive(dir, out = []) {
  if (!dir || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) listFilesRecursive(full, out);
    else out.push(full);
  }
  return out;
}

/** 归档快照：路径（相对归档根，统一 /）→ { abs, size, sha256 }。 */
function snapshot(paths) {
  const files = [...listFilesRecursive(paths.dir)];
  for (const extra of [paths.index, paths.readme]) {
    if (existsSync(extra)) files.push(extra);
  }
  const map = new Map();
  for (const file of files) {
    if (!existsSync(file)) continue;
    map.set(rel(paths.root, file), { abs: file, size: statSync(file).size, sha256: sha256File(file) });
  }
  return map;
}

/** 扫描前的失败段名单（读文件仅用于判定失败/已有有效 repair，不输出任何正文）。 */
function inspectFailedChunks(paths, chunkFiles, cfg) {
  const failed = [];
  const alreadyRepaired = [];
  for (const file of chunkFiles) {
    let text = "";
    try {
      text = readFileSync(join(paths.dir, file), "utf8");
    } catch {
      continue;
    }
    if (failedSummary(extractSummary(text))) {
      failed.push(file);
      if (validRepair(paths, file, cfg, text)) alreadyRepaired.push(file);
    }
  }
  return { failed, alreadyRepaired };
}

function sidecarMeta(paths, file) {
  const payload = store.readRepair(paths, file);
  if (!payload) return null;
  let bytes = null;
  try {
    bytes = statSync(store.repairFile(paths, file)).size;
  } catch {
    bytes = null;
  }
  return {
    file,
    bytes,
    passes: nf(Number(payload.passes)),
    usage: {
      inputTokens: nf(Number(payload.usage?.inputTokens)),
      outputTokens: nf(Number(payload.usage?.outputTokens)),
      totalTokens: nf(Number(payload.usage?.totalTokens)),
      calls: nf(Number(payload.usage?.calls)),
    },
    model: typeof payload.model === "string" ? payload.model : null,
    builtAt: typeof payload.builtAt === "string" ? payload.builtAt : null,
    textChars: typeof payload.text === "string" ? payload.text.length : null,
  };
}

/* ==================== fetch 计数壳（不落正文/头/密钥） ==================== */

function installFetchMeter() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function meteredFetch(input, init) {
    let maxTokens = null;
    let requestedModel = null;
    if (typeof init?.body === "string") {
      try {
        const sent = JSON.parse(init.body);
        maxTokens = nf(Number(sent?.max_tokens));
        requestedModel = typeof sent?.model === "string" ? sent.model : null;
      } catch {
        /* 请求体不是 JSON：只记次数 */
      }
    }
    const res = await original(input, init);
    const entry = { n: calls.length + 1, ok: Boolean(res.ok), status: res.status, requestedModel, responseModel: null, finishReason: null, usage: null, maxTokens, parsed: false };
    try {
      const type = String(res.headers?.get?.("content-type") ?? "");
      if (type.includes("json") || type === "") {
        // 只解析一份克隆，提取 usage/model/finish_reason；正文与 headers 绝不保留。
        const json = JSON.parse(await res.clone().text());
        entry.parsed = true;
        entry.responseModel = typeof json?.model === "string" ? json.model : null;
        entry.finishReason = json?.choices?.[0]?.finish_reason ?? null;
        const usage = json?.usage;
        if (usage && typeof usage === "object") {
          entry.usage = {
            inputTokens: nf(Number(usage.prompt_tokens)),
            outputTokens: nf(Number(usage.completion_tokens)),
            totalTokens: nf(Number(usage.total_tokens)),
          };
        }
      }
    } catch {
      /* 解析失败只标记，不落任何响应内容 */
    }
    calls.push(entry);
    return res;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function summarizeCalls(calls) {
  const models = [...new Set(calls.map((c) => c.responseModel ?? c.requestedModel).filter(Boolean))];
  const finishReasons = {};
  for (const call of calls) {
    const key = call.finishReason ?? (call.ok ? "unknown" : `http-${call.status}`);
    finishReasons[key] = (finishReasons[key] ?? 0) + 1;
  }
  return {
    calls: calls.length,
    ok: calls.filter((c) => c.ok).length,
    failed: calls.filter((c) => !c.ok).length,
    inputTokens: sum(calls.map((c) => c.usage?.inputTokens)),
    outputTokens: sum(calls.map((c) => c.usage?.outputTokens)),
    totalTokens: sum(calls.map((c) => c.usage?.totalTokens)),
    models,
    finishReasons,
    maxTokensSeen: [...new Set(calls.map((c) => c.maxTokens).filter((v) => v != null))],
  };
}

/* ==================== 主流程 ==================== */

const startedAt = nowIso();
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${process.pid}${args.label ? `-${args.label.replace(/[^\w.-]/g, "_")}` : ""}`;
const RUN_DIR = join(PROJECT_ROOT, ".zcode", "tests", `repair-real-${runId}`);

function bail(code, message, extra = {}) {
  console.error(`[refuse] ${message}`);
  for (const [key, value] of Object.entries(extra)) console.error(`         ${key}: ${value}`);
  process.exit(code);
}

{
  const low = (value) => resolve(value).toLowerCase();
  if (!low(RUN_DIR).startsWith(low(PROJECT_ROOT))) bail(64, `运行目录必须在项目内: ${RUN_DIR}`);
  if (low(RUN_DIR).includes(low(join(PROJECT_ROOT, ".无痛切")))) bail(64, "运行目录不得靠近真实归档目录");
}

const cfg = loadConfig();
const source = getSource("zcode");
let resolved;
try {
  resolved = resolveCurrentSession({ cwd: args.cwd || process.env.ZCODE_PROJECT_DIR || process.cwd(), sessionId: args.session || undefined });
} catch (err) {
  bail(3, `解析会话失败: ${String(err?.message ?? err)}`, { cwd: args.cwd || process.cwd() });
}
const session = resolved.session;
const cwd = resolved.cwd;
const paths = store.sessionPaths(cwd, session, cfg);

const chunkFilesBefore = store.listChunkFiles(paths.dir);
let compactionsBefore = [];
let failedBefore = [];
let alreadyRepaired = [];
try {
  compactionsBefore = source.listCompactions(session.id).map((item) => item.boundaryId);
  ({ failed: failedBefore, alreadyRepaired } = inspectFailedChunks(paths, chunkFilesBefore, cfg));
} catch (err) {
  bail(3, `读取会话归档/压缩边界失败: ${String(err?.message ?? err)}`, { sessionId: session.id, cwd });
}

let providerMeta;
try {
  const selected = pickProvider({ providerId: cfg.llmProviderId, modelId: cfg.llmModelId });
  providerMeta = { providerId: selected.providerId, name: selected.name, modelId: selected.modelId };
} catch (err) {
  providerMeta = { providerId: cfg.llmProviderId || null, name: null, modelId: cfg.llmModelId || null, error: String(err?.message ?? err) };
}
let limits = null;
let limitsError = null;
try {
  limits = requestLimits({ contextTokens: cfg.summaryContextTokens, maxOutputTokens: cfg.summaryOutputTokens });
} catch (err) {
  limitsError = String(err?.message ?? err);
}

const preflight = {
  sessionId: session.id,
  cwd,
  archiveRoot: paths.root,
  chunkCount: chunkFilesBefore.length,
  failedCount: failedBefore.length,
  failedFiles: failedBefore,
  alreadyRepaired,
  provider: providerMeta,
  budget: { contextTokens: cfg.summaryContextTokens, outputTokens: cfg.summaryOutputTokens, ...(limits ?? {}), reserve: 1024, margin: 1536 },
  limitsError,
  pluginData: PLUGIN_DATA,
  jobsDir: join(PLUGIN_DATA, "jobs"),
};

if (args.preflight) {
  console.log(JSON.stringify({ preflight: true, expectedFailed: args.expectFailed, ...preflight }, null, 2));
  process.exit(0);
}

if (args.expectFailed == null) {
  bail(64, [
    `未指定 --expect-failed。当前检测到 ${failedBefore.length} 个失败段：${failedBefore.join(", ") || "(无)"}`,
    "为防误伤其他归档，请显式指定期望数量后重跑（数量不符时不会写任何文件）：",
    `  node ${process.argv[1]} --cwd "${cwd}" --session ${session.id} --expect-failed ${failedBefore.length}`,
  ].join("\n"), { sessionId: session.id, cwd, failedFiles: failedBefore });
}

if (failedBefore.length !== args.expectFailed && !args.allowCountMismatch) {
  bail(3, `失败段数量与期望不符：期望 ${args.expectFailed}，实际 ${failedBefore.length}（未写任何文件）`, {
    sessionId: session.id,
    cwd,
    failedFiles: failedBefore.join(", ") || "(无)",
  });
}

mkdirSync(RUN_DIR, { recursive: true });

/* ---------- claim job（单飞；不碰别人的锁） ---------- */

const existing = readJob(session.id);
if (existing && ["queued", "running"].includes(existing.status)) {
  bail(2, "该会话已有活动任务，拒绝并发（不清理任何锁）", {
    mode: existing.mode ?? "?",
    status: existing.status,
    pid: existing.pid ?? "?",
    startedAt: existing.startedAt ?? "?",
  });
}
const job = claimJob(session.id, { mode: "repair", cwd, resolvedBy: "repair-script" });
if (!job) {
  const current = readJob(session.id);
  bail(2, "claim 失败：锁被其他进程占用，拒绝并发（不清理任何锁）", {
    mode: current?.mode ?? "?",
    status: current?.status ?? "?",
    pid: current?.pid ?? "?",
  });
}

let lockLost = false;
let lastJobWrite = 0;
const touchJob = (patch, force = false) => {
  const now = Date.now();
  if (!force && now - lastJobWrite < 3000) return;
  lastJobWrite = now;
  if (!updateJob(session.id, job.jobId, patch)) lockLost = true;
};
const heartbeat = setInterval(() => touchJob({ heartbeatAt: nowIso() }, true), 15000);
heartbeat.unref?.();

/* ---------- 备份 + sha256 清单核验 ---------- */

const backupDir = join(RUN_DIR, "backup");
const beforeSnapshot = snapshot(paths);
let manifest = null;
try {
  touchJob({ status: "running", phase: "backup" }, true);
  for (const [key, item] of beforeSnapshot) {
    const dest = join(backupDir, ...key.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(item.abs, dest);
    if (sha256File(dest) !== item.sha256) throw new Error(`备份核验失败: ${key}`);
  }
  manifest = {
    sessionId: session.id,
    cwd,
    archiveRoot: paths.root,
    createdAt: nowIso(),
    fileCount: beforeSnapshot.size,
    totalBytes: sum([...beforeSnapshot.values()].map((item) => item.size)),
    files: [...beforeSnapshot.entries()].map(([path, item]) => ({ path, size: item.size, sha256: item.sha256 })),
  };
  writeFileSync(join(RUN_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
} catch (err) {
  clearInterval(heartbeat);
  finishJob(session.id, job.jobId, { status: "error", phase: "backup", mode: "repair", error: String(err?.message ?? err) });
  bail(4, `备份失败，未执行扫描: ${String(err?.message ?? err)}`, { runDir: RUN_DIR });
}

/* ---------- scan（只修复，不 buildTotal） ---------- */

const meter = installFetchMeter();
let scanResult = null;
let scanError = null;
const scanStarted = Date.now();
let phase = "";
const onProgress = (progress) => {
  const next = String(progress?.phase ?? "");
  const done = Number(progress?.progress ?? 0);
  const total = Number(progress?.count ?? 0);
  if (next && next !== phase) {
    phase = next;
    console.log(`[progress] ${next}`);
    touchJob({ phase: next }, true);
  } else if (next && total > 0 && done === total) {
    console.log(`[progress] ${next} ${done}/${total}`);
    touchJob({ phase: next, progress: done, count: total });
  }
};

try {
  touchJob({ status: "running", phase: "repair" }, true);
  scanResult = await scanSession(session.id, { cwd, cfg, summarize: true, repairFailed: true, onProgress });
} catch (err) {
  scanError = String(err?.message ?? err);
} finally {
  clearInterval(heartbeat);
  meter.restore();
}
const callsSummary = summarizeCalls(meter.calls);

/* ---------- 扫描后比对 ---------- */

const afterSnapshot = snapshot(paths);
const repairsPrefix = rel(paths.root, join(paths.dir, "repairs")) + "/";
const allowedKeys = new Set([
  rel(paths.root, paths.state),
  rel(paths.root, paths.live),
  rel(paths.root, paths.meta),
  rel(paths.root, paths.index),
  rel(paths.root, paths.readme),
  rel(paths.root, join(paths.rawDir, "LIVE.md")), // 标准 scan 会刷新 LIVE 的 raw 副本
  ...failedBefore.filter((file) => !alreadyRepaired.includes(file))
    .map((file) => rel(paths.root, store.repairFile(paths, file))),
]);

const changed = [];
const missing = [];
for (const [key, item] of beforeSnapshot) {
  const next = afterSnapshot.get(key);
  if (!next) missing.push({ path: key, before: item.sha256 });
  else if (next.sha256 !== item.sha256) changed.push({ path: key, before: item.sha256, after: next.sha256, allowed: allowedKeys.has(key) });
}
const added = [];
for (const [key, item] of afterSnapshot) {
  if (beforeSnapshot.has(key)) continue;
  const kind = key.startsWith(repairsPrefix) && key.endsWith(".json")
    ? "repair-sidecar"
    : key === rel(paths.root, join(paths.rawDir, "LIVE.md"))
      ? "live-raw"
      : /\/raw\//.test(key)
        ? "raw"
        : key.endsWith(".md")
          ? "md"
          : "other";
  added.push({ path: key, size: item.size, sha256: item.sha256, kind });
}

const chunkFilesAfter = store.listChunkFiles(paths.dir);
const newChunkFiles = chunkFilesAfter.filter((file) => !chunkFilesBefore.includes(file));
let compactionsAfter = compactionsBefore;
let postCompactionsError = null;
try {
  compactionsAfter = source.listCompactions(session.id).map((item) => item.boundaryId);
} catch (err) {
  postCompactionsError = String(err?.message ?? err);
}
const newBoundaries = compactionsAfter.filter((id) => !compactionsBefore.includes(id));

const repairedNow = failedBefore.filter((file) => {
  const full = join(paths.dir, file);
  if (!existsSync(full)) return false;
  return Boolean(validRepair(paths, file, cfg, readFileSync(full, "utf8")));
});
const repairedThisRun = repairedNow.filter((file) => !alreadyRepaired.includes(file));
const repairedDetails = repairedThisRun.map((file) => sidecarMeta(paths, file)).filter(Boolean);
const failedRemaining = failedBefore.filter((file) => !repairedNow.includes(file));

const violations = [
  ...changed.filter((item) => !item.allowed).map((item) => ({ ...item, reason: "原文件内容被改写" })),
  ...missing.map((item) => ({ ...item, reason: "原文件丢失" })),
];

const scanErrors = (scanResult?.errors ?? []).map((item) => ({ file: item.file ?? null, boundaryId: item.boundaryId ?? null, error: String(item.error ?? ""), usage: item.usage ?? null, passes: item.passes ?? null }));
const sidecarFilesAdded = added
  .filter((item) => item.kind === "repair-sidecar")
  .map((item) => item.path.slice(item.path.lastIndexOf("/") + 1).replace(/\.json$/, ""));
const unexpectedRepairs = [...new Set([...(scanResult?.repairs ?? []), ...sidecarFilesAdded])].filter((file) => !failedBefore.includes(file));
const newFailuresNotCounted = scanErrors.some((item) => !item.file || !failedBefore.includes(item.file)) || unexpectedRepairs.length > 0;
const maxTokensUniform = meter.calls.length > 0 && meter.calls.every((call) => call.maxTokens === cfg.summaryOutputTokens);

const report = {
  script: "repair-failed-summaries",
  startedAt,
  finishedAt: nowIso(),
  durationMs: Date.now() - scanStarted,
  sessionId: session.id,
  cwd,
  archiveRoot: paths.root,
  runDir: RUN_DIR,
  provider: providerMeta,
  budget: {
    contextTokens: cfg.summaryContextTokens,
    outputTokens: cfg.summaryOutputTokens,
    inputBudget: limits?.input ?? null,
    reserve: 1024,
    margin: 1536,
    limitsError,
  },
  failedBefore,
  alreadyRepairedBefore: alreadyRepaired,
  repaired: repairedDetails,
  repairedCount: repairedThisRun.length,
  failedRemaining,
  failedRemainingCount: failedRemaining.length,
  llmCalls: { ...callsSummary, maxTokensUniform },
  writes: { changed, added, missing, violations },
  newChunksSinceStart: newChunkFiles,
  newBoundariesSinceStart: newBoundaries,
  unexpectedRepairs,
  newFailuresNotCounted,
  scanErrors,
  postCompactionsError,
  lock: { jobId: job.jobId, heartbeatAt: nowIso(), lockLost },
  scanError,
  expectedFailed: args.expectFailed,
};

writeFileSync(join(RUN_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

const md = [
  "# 无痛切 · 失败段修复报告",
  "",
  `- 时间：${report.startedAt} → ${report.finishedAt}（${report.durationMs} ms）`,
  `- 会话：${session.id}`,
  `- 工作区：${cwd}`,
  `- 归档根：${paths.root}`,
  `- 备份：${join(RUN_DIR, "backup")}（${manifest?.fileCount ?? 0} 个文件，sha256 清单已核验）`,
  "",
  "## 模型与预算",
  `- Provider：${providerMeta.name ?? "?"}（${providerMeta.providerId ?? "?"}）`,
  `- 模型：${providerMeta.modelId ?? "?"}`,
  `- 预算：context=${cfg.summaryContextTokens} / output=${cfg.summaryOutputTokens} / input=${limits?.input ?? "?"}（预留 1024，余量 1536）`,
  `- 请求 max_tokens：${callsSummary.maxTokensSeen.length ? callsSummary.maxTokensSeen.join(", ") : "(未记录)"}（与配置 output 一致：${maxTokensUniform ? "是" : "否/未调用"}）`,
  "",
  "## 失败段与修复",
  `- 扫描前失败段：${failedBefore.length} 个（期望 ${args.expectFailed}）`,
  ...failedBefore.map((file) => `  - ${file}${alreadyRepaired.includes(file) ? "（已有有效 repair，跳过）" : ""}`),
  `- 本次修复：${repairedThisRun.length} 个`,
  ...repairedDetails.map((item) => `  - ${item.file}：sidecar=${item.bytes} B，passes=${item.passes ?? "?"}，usage=${JSON.stringify(item.usage)}，model=${item.model ?? "?"}`),
  `- 仍失败：${failedRemaining.length} 个${failedRemaining.length ? `（${failedRemaining.join(", ")}）` : ""}`,
  "",
  "## 模型调用（仅计数与 usage）",
  `- 调用：${callsSummary.calls} 次（成功 ${callsSummary.ok} / 失败 ${callsSummary.failed}）`,
  `- tokens：input=${callsSummary.inputTokens} output=${callsSummary.outputTokens} total=${callsSummary.totalTokens}`,
  `- 返回模型：${callsSummary.models.join(", ") || "(无)"}`,
  `- finish_reason：${JSON.stringify(callsSummary.finishReasons)}`,
  "",
  "## 逐文件哈希比对",
  ...changed.map((item) => `- 变化${item.allowed ? "（允许的 scan 更新）" : "（violation）"}：${item.path} ${item.before.slice(0, 12)} → ${item.after.slice(0, 12)}`),
  ...added.map((item) => `- 新增（${item.kind}）：${item.path} ${item.sha256.slice(0, 12)}（${item.size} B）`),
  ...missing.map((item) => `- 丢失（violation）：${item.path}（原 ${item.before.slice(0, 12)}）`),
  "",
  "## 新 boundary / 新 chunk",
  `- 新增 chunk：${newChunkFiles.length ? newChunkFiles.join(", ") : "(无)"}`,
  `- 新增 boundary：${newBoundaries.length ? newBoundaries.join(", ") : "(无)"}`,
  `- 新失败未计入修复成功：${newFailuresNotCounted ? "是（见 scanErrors/unexpectedRepairs）" : "否"}`,
  ...scanErrors.map((item) => `  - scan 错误：${item.file ?? item.boundaryId ?? "?"}：${item.error}`),
  "",
  `扫描错误：${scanError ?? "(无)"}`,
  `扫描后读取压缩边界：${postCompactionsError ?? "(正常)"}`,
  `lock：jobId=${job.jobId} heartbeated=${!lockLost}`,
  "",
].join("\n");
writeFileSync(join(RUN_DIR, "report.md"), md, "utf8");

const ok = !scanError && violations.length === 0 && failedRemaining.length === 0 && scanErrors.length === 0 && !postCompactionsError && !lockLost;
finishJob(session.id, job.jobId, {
  status: ok ? "done" : "error",
  phase: ok ? "done" : "error",
  mode: "repair",
  error: scanError
    ?? (violations.length ? `发现 ${violations.length} 处原文件被改写/丢失`
      : failedRemaining.length ? `仍有 ${failedRemaining.length} 个失败段`
        : scanErrors.length ? `scan 报告 ${scanErrors.length} 条错误（新内容失败不计入修复成功）`
          : postCompactionsError ? `扫描后读取压缩边界失败: ${postCompactionsError}`
            : lockLost ? "运行中 job 锁被其他进程接管（未清理任何锁）"
              : null),
  repairedCount: repairedThisRun.length,
  failedBeforeCount: failedBefore.length,
  failedRemainingCount: failedRemaining.length,
  newChunksCount: newChunkFiles.length,
  reportPath: join(RUN_DIR, "report.json"),
  durationMs: report.durationMs,
});

console.log(JSON.stringify({
  ok,
  sessionId: session.id,
  cwd,
  runDir: RUN_DIR,
  provider: providerMeta,
  budget: report.budget,
  failedBefore: failedBefore.length,
  repaired: repairedThisRun.length,
  failedRemaining: failedRemaining,
  llmCalls: { ...callsSummary, maxTokensUniform },
  violations: violations.map((item) => item.path),
  newChunksSinceStart: newChunkFiles,
  newBoundariesSinceStart: newBoundaries,
  scanError,
  scanErrors,
  postCompactionsError,
  report: { json: join(RUN_DIR, "report.json"), md: join(RUN_DIR, "report.md") },
}, null, 2));

process.exit(ok ? 0 : 1);
