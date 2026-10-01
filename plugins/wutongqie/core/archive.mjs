// 归档引擎。hook、MCP 工具、网页面板都调用这里，保证行为一致。
//
// 一次 scanSession 做的事：
//   1. 读出该会话所有已完成的压缩边界
//   2. 跟 state.json 里已处理的 boundaryId 求差集
//   3. 对每个新边界：切出被丢弃的对话段 → 渲染 → 调模型写段摘要 → 落盘
//   4. 顺带刷新 LIVE 段（仍在上下文里的活跃尾巴）
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSource } from "./sources/index.mjs";
import { renderSegment, chunkFilename, fmtTime, fmtIso, approxTokens } from "./render.mjs";
import { buildChunkSummary, buildTotalSummary, buildRollingSummary, rollingSummaryMessages } from "./summarize.mjs";
import { requestFits, requestLimits } from "./budget.mjs";
import { extractSummary, failedSummary, validRepair, needsRepair, recoverChunk, summaryConfigKey } from "./chunk-input.mjs";
import * as store from "./store.mjs";
import { loadConfig, logEvent } from "./config.mjs";
import { buildHighlights, buildHandoverText } from "./handoff.mjs";
import { sameWorkspace } from "./current-session.mjs";

function llmOpts(cfg) {
  return {
    providerId: cfg.llmProviderId,
    modelId: cfg.llmModelId,
    timeoutMs: cfg.llmTimeoutMs,
    contextTokens: cfg.summaryContextTokens,
    maxOutputTokens: cfg.summaryOutputTokens,
    fallback: true,
  };
}

// 指纹版本：v2 起只哈希"实际进入摘要的内容"（渲染后的 LIVE 文本 + 边界 + 影响内容的配置），
// 不再包含 maxSequence——只新增被过滤的系统消息时 LIVE 摘要可以直接复用。
const LIVE_HASH_VERSION = 3;
// 连续滚动归并的次数上限；达到后强制做一次全量 map-reduce，避免摘要越滚越失真。
const ROLLING_MAX_DEFAULT = 5;
// 最终正文 + 增量超过这个硬上限时不能塞进一次滚动归并请求。
const ROLLING_HARD_CAP_CHARS = 180000;

function hashLiveInput({ session, source, comps, cfg, live }) {
  const payload = {
    version: LIVE_HASH_VERSION,
    sessionId: session.id,
    title: session.title ?? "",
    boundaryId: comps.at(-1)?.boundaryId ?? null,
    transcript: live?.transcript ?? "",
    maxMessageChars: cfg.maxMessageChars ?? null,
    maxTranscriptChars: cfg.maxTranscriptChars ?? null,
    toolOutputPreview: cfg.toolOutputPreview ?? null,
    providerId: cfg.llmProviderId ?? "",
    modelId: cfg.llmModelId ?? "",
    contextTokens: requestLimits(llmOpts(cfg)).context,
    outputTokens: requestLimits(llmOpts(cfg)).output,
  };
  return store.sha256(JSON.stringify(payload));
}

function totalConfigKey(cfg) {
  return JSON.stringify({
    version: 3,
    summaryContextTokens: requestLimits(llmOpts(cfg)).context,
    summaryOutputTokens: requestLimits(llmOpts(cfg)).output,
    toolOutputPreview: cfg.toolOutputPreview ?? null,
    maxMessageChars: cfg.maxMessageChars ?? null,
    maxTranscriptChars: cfg.maxTranscriptChars ?? null,
    mergeBudgetChars: cfg.mergeBudgetChars ?? null,
    llmProviderId: cfg.llmProviderId ?? "",
    llmModelId: cfg.llmModelId ?? "",
    skipLiveForTotal: Boolean(cfg.skipLiveForTotal),
  });
}

function sameList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => JSON.stringify(value) === JSON.stringify(b[index]));
}

/** 段文件快照：size + mtime + 内容哈希。哈希覆盖实际内容，改坏/换掉文件都会被识别。 */
function chunkSnapshot(dir, files) {
  return files.map((file) => {
    try {
      const stat = statSync(join(dir, file));
      return { file, size: stat.size, mtimeMs: stat.mtimeMs, hash: store.fileContentHash(join(dir, file)), repairHash: store.fileContentHash(join(dir, "repairs", `${file}.json`)) };
    } catch {
      return { file, missing: true };
    }
  });
}

/** base 是否正好是 current 的连续前缀（逐字段比较，含内容哈希）。 */
function isSnapshotPrefix(base, current) {
  if (!Array.isArray(base) || !Array.isArray(current) || base.length > current.length) return false;
  return base.every((item, index) => JSON.stringify(item) === JSON.stringify(current[index]));
}

function stateTime(value, fallback = 0) {
  return store.stateTime(value, fallback);
}

function writeIntermediateState(paths, state) {
  // scan/live 的中间写入不能覆盖 prepare 已经生成的可复制草稿，
  // 也不能在最终 TOTAL 已完成后把旧草稿复活。store.mergeState 会按 builtAt
  // 选择较新的一侧，并保证 processed/chunkIndex 只增不减。
  return store.mergeState(paths, state);
}

function reusableTotal({ state, paths, session, source, comps, chunkFiles, live, cfg }) {
  const total = state.total;
  if (state.draft || state.liveSummary?.warning || !total || !store.hasTotal(paths)) return null;
  // 机械 fallback 只是"模型暂时不可用"的替身，不能当成最终版永久命中缓存。
  if (total.isFallback || total.isDraft) return null;
  if (total.sessionId !== session.id) return null;
  if (state.totalConfigKey !== totalConfigKey(cfg)) return null;
  // TOTAL.md 必须与生成时逐字节一致：被删除、截断、改写都拒绝命中缓存。
  const contentHash = store.totalContentHash(paths);
  if (!state.totalContentHash || !contentHash || contentHash !== state.totalContentHash) return null;
  // 段来源快照必须没变过；快照里带内容哈希，改坏段文件同样失效。
  if (!Array.isArray(state.totalSourceFiles) || !sameList(state.totalSourceFiles, chunkSnapshot(paths.dir, chunkFiles))) return null;
  if (chunkFiles.some((file) => needsRepair(paths, file, cfg))) return null;
  if (!Array.isArray(state.processed) || state.processed.length !== comps.length) return null;
  if (comps.some((item) => !state.processed.includes(item.boundaryId))) return null;

  const liveIncluded = !cfg.skipLiveForTotal && Boolean(live);
  const liveHash = hashLiveInput({ session, source, comps, cfg, live });
  if (state.liveInputHash !== liveHash) return null;
  if (state.totalLiveInputHash !== (liveIncluded ? liveHash : null)) return null;
  if (Boolean(total.liveIncluded) !== liveIncluded) return null;
  if (Number(total.chunkCount) !== chunkFiles.length + (liveIncluded ? 1 : 0)) return null;
  if (state.totalThroughSequence == null || total.throughSequence == null) return null;

  return { ...total, reused: true, cached: true };
}

export function getReusableTotal({ sessionOrId, cwd, cfg = loadConfig() } = {}) {
  const source = getSource("zcode");
  const session = typeof sessionOrId === "string" ? source.getSession(sessionOrId) : sessionOrId;
  if (!session) throw new Error(`找不到会话: ${sessionOrId}`);
  if (cwd && !sameWorkspace(cwd, session.cwd)) throw new Error("归档工作区与会话不一致，已停止写入。");
  const paths = store.sessionPaths(session.cwd, session, cfg);
  const state = store.readState(paths);
  const compactions = source.listCompactions(session.id);
  const chunkFiles = store.listChunkFiles(paths.dir);
  const live = liveContent({ session, source, comps: compactions, cfg });
  const total = reusableTotal({ state, paths, session, source, comps: compactions, chunkFiles, live, cfg });
  return { total, session, paths, state, compactions, chunkFiles, live };
}

function chunkFrontMatter({ session, boundary, stats, index, total, path, model }) {
  const lines = [
    "---",
    `session: "${session.id}"`,
    `session_title: "${String(session.title).replace(/"/g, "'")}"`,
    `cwd: "${session.cwd}"`,
    `chunk: ${index}`,
    `boundary_id: "${boundary.boundaryId}"`,
    `compacted_at: ${boundary.time}`,
    `compacted_from: ${boundary.startedAt}`,
    `trigger: ${boundary.trigger ?? "?"}`,
    `phase: ${boundary.phase ?? "?"}`,
    `tokens_before: ${boundary.preCompactTokenCount ?? "?"}`,
    `tokens_after: ${boundary.postCompactTokenCount ?? "?"}`,
    `message_range: "${stats.fromSeq + 1}..${stats.toSeq - 1}"`,
    `user_messages: ${stats.userCount}`,
    `assistant_messages: ${stats.assistantCount}`,
    `tool_calls: ${stats.toolCount}`,
    `summary_model: "${model ?? "?"}"`,
    `archived_at: ${new Date().toISOString()}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

function chunkHeader({ session, boundary, index, total, stats }) {
  return [
    `# 第 ${index}/${total} 段归档摘要 · ${session.title}`,
    "",
    `> 这段对话在 **${fmtIso(boundary.time)}** 被上下文压缩吞掉（${boundary.trigger}/${boundary.phase}，上下文 ${boundary.preCompactTokenCount ?? "?"} → ${boundary.postCompactTokenCount ?? "?"} token）。`,
    `> 原始区间 message sequence ${stats.fromSeq + 1}..${stats.toSeq - 1}，共 ${stats.totalRows} 行记录、${stats.toolCount} 次工具调用。`,
    "",
  ].join("\n");
}

/**
 * 扫描并归档一个新会话。幂等：已处理过的 boundaryId 不会重复归档。
 * @returns {{session, chunks: Array, live: object|null, newCount: number, errors: Array}}
 */
export async function scanSession(sessionOrId, { cwd, cfg = loadConfig(), summarize = true, repairFailed = false, onProgress = () => {} } = {}) {
  const source = getSource("zcode");
  const session = typeof sessionOrId === "string" ? source.getSession(sessionOrId) : sessionOrId;
  if (!session) throw new Error(`找不到会话: ${sessionOrId}`);

  if (cwd && !sameWorkspace(cwd, session.cwd)) throw new Error("归档工作区与会话不一致，已停止写入。");
  const workdir = session.cwd;
  const paths = store.sessionPaths(workdir, session, cfg);
  store.writeRootReadme(paths);
  store.writeMeta(paths, session);

  // scan 与 prepare 草稿可能并发运行；state 每次中间写入都通过 mergeState 与磁盘取并集/取新。
  let state = store.readState(paths);
  const processed = new Set(state.processed);
  const comps = source.listCompactions(session.id);
  const fresh = comps.filter((c) => !processed.has(c.boundaryId));

  const newChunks = [];
  const errors = [];

  for (let i = 0; i < fresh.length; i++) {
    const boundary = fresh[i];
    onProgress({ phase: "archive", progress: i, count: fresh.length });
    const index = state.chunkIndex + 1;
    const previous = comps[comps.indexOf(boundary) - 1];
    const fromSeq = previous ? previous.tailSequence - 1 : -1;
    if (typeof boundary.tailSequence !== "number") {
      errors.push({ boundaryId: boundary.boundaryId, error: "无法定位切点（缺少 tailSequence）" });
      continue;
    }
    if (boundary.tailSequence <= fromSeq + 1) {
      // 被丢弃的区间为空（比如刚发生过连续压缩），只记幂等，不写文件
      state.processed.push(boundary.boundaryId);
      state = writeIntermediateState(paths, state);
      continue;
    }

    const segment = source.getSegment(session.id, fromSeq, boundary.tailSequence);
    const compactMd = renderSegment(segment, { maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240 });
    const rawMd = renderSegment(segment, { maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240 });
    const filename = chunkFilename(index, boundary.time);

    if (cfg.saveRaw) {
      store.writeRaw(
        paths,
        filename,
        [
          `<!-- 无痛切 · 第 ${index} 段原文 -->`,
          `<!-- 会话 ${session.id} / 区间 ${segment.stats.fromSeq + 1}..${segment.stats.toSeq - 1} / 被压缩于 ${boundary.time} -->`,
          "",
          rawMd,
        ].join("\n"),
      );
    }

    let summaryBody = null;
    let model = null;
    if (summarize && compactMd.trim()) {
      try {
        const r = await buildChunkSummary({
          meta: {
            sessionTitle: session.title,
            index,
            total: state.chunkIndex + fresh.length,
            fromTime: segment.messages[0]?.time,
            toTime: segment.messages.at(-1)?.time,
            trigger: boundary.trigger,
            phase: boundary.phase,
            preCompactTokenCount: boundary.preCompactTokenCount,
            postCompactTokenCount: boundary.postCompactTokenCount,
            stats: segment.stats,
          },
          transcript: compactMd,
          officialSummary: boundary.officialSummary,
          budgetChars: cfg.maxTranscriptChars,
          llm: llmOpts(cfg),
          onProgress,
        });
        summaryBody = r.markdown.trim();
        model = `${r.provider}/${r.model}`;
      } catch (err) {
        errors.push({ boundaryId: boundary.boundaryId, error: `摘要失败: ${err.message}`, usage: err.usage ?? null, passes: err.passes ?? null });
      }
    }

    const parts = [
      chunkFrontMatter({ session, boundary, stats: segment.stats, index, total: state.chunkIndex + fresh.length, model }),
      chunkHeader({ session, boundary, index, total: state.chunkIndex + fresh.length, stats: segment.stats }),
    ];
    if (summaryBody) {
      parts.push("## 归档摘要\n", summaryBody, "");
    } else {
      parts.push("## 归档摘要\n", "_摘要生成失败，本段仅保留原文。_", "");
    }
    if (boundary.officialSummary) {
      parts.push(
        "<details>",
        "<summary>附：这次压缩时 ZCode 自己生成的摘要（更早的历史）</summary>",
        "",
        boundary.officialSummary,
        "",
        "</details>",
        "",
      );
    }
    const mdPath = store.writeChunk(paths, filename, parts.join("\n"));

    state.processed.push(boundary.boundaryId);
    state.chunkIndex = index;
    state = writeIntermediateState(paths, state);

    const item = {
      index,
      file: filename,
      path: mdPath,
      boundaryId: boundary.boundaryId,
      compactedAt: boundary.time,
      trigger: boundary.trigger,
      tokens: `${boundary.preCompactTokenCount ?? "?"}→${boundary.postCompactTokenCount ?? "?"}`,
      rows: segment.stats.totalRows,
      toolCalls: segment.stats.toolCount,
      chars: compactMd.length,
      approxTokens: approxTokens(compactMd),
      summarized: Boolean(summaryBody),
      model,
    };
    newChunks.push(item);
    logEvent("chunk", { sessionId: session.id, ...item });
  }

  const repaired = repairFailed && summarize
    ? await repairFailedChunks({ session, source, paths, cfg, comps, files: store.listChunkFiles(paths.dir).filter((file) => !newChunks.some((chunk) => chunk.file === file)), onProgress })
    : { repaired: [], errors: [] };
  errors.push(...repaired.errors);

  // 活跃尾巴（还没被压缩，但换会话就会丢）
  const live = refreshLive({ session, source, paths, cfg, state, comps, summarize });

  // scan 与 prepare 草稿可能并发运行；这里只写自己的进度字段，
  // 交接结果（total/draft/lastFinalTotal）由 mergeState 按 builtAt 保留较新的一侧。
  state = writeIntermediateState(paths, state);
  store.rebuildIndex(paths.root);
  return { session, paths, chunks: newChunks, live, newCount: newChunks.length, repairedCount: repaired.repaired.length, repairs: repaired.repaired, errors, state, compactions: comps };
}

function liveContent({ session, source, comps, cfg }) {
  // tail_start_id 是保留下来的首条消息；getSegment 的左边界是开区间。
  const fromSeq = comps.length ? comps.at(-1).tailSequence - 1 : -1;
  const maxSeq = source.maxSequence(session.id);
  const segment = source.getSegment(session.id, fromSeq, maxSeq + 1);
  const transcript = renderSegment(segment, { maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240 });
  if (!transcript.trim()) return null;
  return { segment, transcript, maxSeq };
}

function liveHeader(session, live) {
  return [
    "<!-- 无痛切 · 当前未压缩内容，准备切换会话时一并纳入交接文档。 -->",
    `<!-- message_range: ${live.segment.stats.fromSeq + 1}..${live.maxSeq} -->`,
    "",
    `# 当前未压缩内容 · ${session.title}`,
    "",
  ].join("\n");
}

function refreshLive({ session, source, paths, cfg, state, comps }) {
  const live = liveContent({ session, source, comps, cfg });
  const liveHash = hashLiveInput({ session, source, comps, cfg, live });
  const now = new Date().toISOString();
  if (!live) {
    state.liveThroughSequence = null;
    state.liveBoundaryId = comps.at(-1)?.boundaryId ?? null;
    state.liveInputHash = liveHash;
    state.liveSummary = null;
    state.liveUpdatedAt = now;
    writeIntermediateState(paths, state);
    return null;
  }
  const head = liveHeader(session, live);
  const prev = existsSync(paths.live) ? readFileSync(paths.live, "utf8") : "";
  const unchanged = state.liveInputHash === liveHash && Boolean(prev);
  if (!unchanged) {
    // LIVE.md 整份替换而不是追加：旧内容不允许残留。
    store.writeLive(paths, head + "\n## 归档摘要\n\n_准备交接时自动整理以下内容。_\n\n## 当前对话原文\n\n" + live.transcript);
  }
  if (cfg.saveRaw) {
    store.writeRaw(paths, "LIVE.md", head + renderSegment(live.segment, { maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240 }));
  }
  state.liveThroughSequence = live.maxSeq;
  state.liveBoundaryId = comps.at(-1)?.boundaryId ?? null;
  state.liveInputHash = liveHash;
  state.liveUpdatedAt = now;
  writeIntermediateState(paths, state);
  return {
    file: "LIVE.md", path: paths.live,
    fromSeq: live.segment.stats.fromSeq + 1, toSeq: live.maxSeq,
    rows: live.segment.stats.totalRows, toolCalls: live.segment.stats.toolCount,
    chars: live.transcript.length, approxTokens: approxTokens(live.transcript),
    inputHash: liveHash,
  };
}

async function summarizeLive({ session, source, paths, cfg, comps }) {
  const live = liveContent({ session, source, comps, cfg });
  const liveHash = hashLiveInput({ session, source, comps, cfg, live });
  if (!live) {
    const state = store.readState(paths);
    state.liveInputHash = liveHash;
    state.liveSummary = null;
    state.liveUpdatedAt = new Date().toISOString();
    writeIntermediateState(paths, state);
    return null;
  }

  // 指纹只覆盖实际进入摘要的渲染文本：只新增被过滤的系统消息时直接复用，不再调模型。
  const cached = store.readState(paths).liveSummary;
  if (!cached?.warning && cached?.inputHash === liveHash && String(cached.text ?? "").trim()) {
    return {
      file: "LIVE.md", text: cached.text, warning: cached.warning ?? null,
      usage: cached.usage ?? null, model: cached.model ?? null,
      throughSequence: live.maxSeq, inputHash: liveHash, reused: true,
    };
  }

  const head = liveHeader(session, live);
  let body;
  let warning = null;
  let usage = null;
  let model = null;
  try {
    const r = await buildChunkSummary({
      meta: {
        sessionTitle: session.title, index: "LIVE", total: "LIVE",
        fromTime: live.segment.messages[0]?.time, toTime: live.segment.messages.at(-1)?.time,
        trigger: "尚未压缩", phase: "live", preCompactTokenCount: null, postCompactTokenCount: null,
        stats: live.segment.stats,
      },
      transcript: live.transcript, officialSummary: null,
      budgetChars: cfg.maxTranscriptChars, llm: llmOpts(cfg),
    });
    body = r.markdown.trim();
    model = `${r.provider}/${r.model}`;
    usage = r.usage;
  } catch (err) {
    warning = `当前内容的单独摘要失败，已保留完整正文用于交接：${String(err?.message ?? err).slice(0, 500)}`;
    body = live.transcript;
    logEvent("live-summary-failed", { sessionId: session.id, error: warning });
  }
  store.writeLive(paths, [head, warning ? `> ${warning}` : `> 使用模型：${model}`, "", "## 归档摘要", "", body, ""].join("\n"));
  const state = store.readState(paths);
  state.liveThroughSequence = live.maxSeq;
  state.liveBoundaryId = comps.at(-1)?.boundaryId ?? null;
  state.liveInputHash = liveHash;
  state.liveSummary = { inputHash: liveHash, text: body, warning, usage, model, throughSequence: live.maxSeq, builtAt: new Date().toISOString() };
  state.liveUpdatedAt = new Date().toISOString();
  writeIntermediateState(paths, state);
  return { file: "LIVE.md", text: body, warning, usage, model, throughSequence: live.maxSeq, inputHash: liveHash };
}

function shortError(err) {
  const first = String(err?.message ?? err ?? "").split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "未知错误";
  return first.slice(0, 300);
}

/** Retry failed summaries into sidecars; immutable original archives remain recoverable. */
async function repairFailedChunks({ session, source, paths, cfg, comps, files, onProgress = () => {} }) {
  const repaired = [];
  const errors = [];
  for (const file of files) {
    const archivedText = readFileSync(join(paths.dir, file), "utf8");
    if (!failedSummary(extractSummary(archivedText)) || validRepair(paths, file, cfg, archivedText)) continue;
    try {
      const input = recoverChunk({ paths, file, archivedText, session, source, comps, cfg });
      const index = Number(file.split("-")[0]);
      const result = await buildChunkSummary({
        meta: {
          sessionTitle: session.title, index, total: files.length,
          trigger: input.boundary?.trigger ?? "修复", phase: "repair",
          stats: { userCount: 0, assistantCount: 0, toolCount: 0 },
        },
        transcript: input.text,
        officialSummary: input.origin === "official" ? null : input.boundary?.officialSummary,
        budgetChars: cfg.maxTranscriptChars, llm: llmOpts(cfg), onProgress,
      });
      const latestText = readFileSync(join(paths.dir, file), "utf8");
      if (validRepair(paths, file, cfg, latestText)) continue;
      if (store.sha256(latestText) !== input.sourceHash) throw new Error("原段在摘要期间发生变化，本次结果未写入，请重新修复。");
      store.writeRepair(paths, file, {
        sourceHash: input.sourceHash, configKey: summaryConfigKey(cfg),
        text: result.markdown, model: `${result.provider}/${result.model}`,
        builtAt: new Date().toISOString(), usage: result.usage, passes: result.passes,
      });
      repaired.push(file);
      logEvent("chunk-repaired", { sessionId: session.id, file, passes: result.passes, usage: result.usage });
    } catch (err) {
      const error = `历史记录 ${file} 的摘要修复失败：${shortError(err)}`;
      const usage = err.usage ?? null;
      const passes = err.passes ?? null;
      errors.push({ file, error, usage, passes });
      logEvent("chunk-repair-failed", { sessionId: session.id, file, error, usage, passes });
    }
  }
  return { repaired, errors };
}

function chunkEntry({ paths, file, index, cfg, session, source, comps, warnings }) {
  const archivedText = readFileSync(join(paths.dir, file), "utf8");
  let body = extractSummary(archivedText);
  const failed = failedSummary(body);
  const repair = failed ? validRepair(paths, file, cfg, archivedText) : null;
  if (repair) {
    body = repair.text;
  } else if (failed) {
    const input = recoverChunk({ paths, file, archivedText, session, source, comps, cfg });
    body = input.text;
    warnings.push(input.origin === "raw"
      ? `历史记录 ${file} 的摘要不可用，已改用原文归并。`
      : `历史记录 ${file} 的摘要不可用，已从会话数据库恢复内容。`);
  }
  const boundaryId = archivedText.match(/^boundary_id: "([^"]+)"/m)?.[1];
  const boundaryIndex = comps.findIndex((item) => item.boundaryId === boundaryId);
  const previousTail = boundaryIndex > 0 ? comps[boundaryIndex - 1].tailSequence : null;
  const rangeStart = Number(archivedText.match(/^message_range: "(\d+)\.\./m)?.[1]);
  if (!failed && previousTail != null && rangeStart === previousTail + 1) {
    const retained = source.getSegment(session.id, previousTail - 1, previousTail + 1);
    const recovered = renderSegment(retained, { maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240 });
    if (recovered.trim()) {
      body = recovered + "\n\n" + body;
      warnings.push(`已补齐旧版历史记录 ${file} 在压缩边界遗漏的消息。`);
    }
  }
  return { label: `第 ${index} 段`, file, text: body };
}

/**
 * 有界滚动归并的准入检查；任一条件不满足就回退全量 map-reduce：
 *   · 存在上一版"模型成功生成"的最终正文（从 state.rollingBase 读，TOTAL.md 被草稿覆盖也不受影响）；
 *   · 当前段文件正好以旧来源快照为连续前缀（逐字段 + 内容哈希），且影响内容的配置一致；
 *   · 确实出现增量（新段或 LIVE 变化），且增量规模在预算内；
 *   · 连续滚动次数没到周期性全量重建阈值。
 */
function rollingPlan({ cfg, session, chunkFiles, snapshot, liveIncluded, liveSummary, base }) {
  if (!base || typeof base.body !== "string" || !base.body.trim()) return null;
  if (base.sessionId && base.sessionId !== session.id) return null;
  if (!base.configKey || base.configKey !== totalConfigKey(cfg)) return null;
  if (!Array.isArray(base.chunkFiles) || !isSnapshotPrefix(base.chunkFiles, snapshot)) return null;
  const used = Number(base.rollingCount ?? 0);
  const configured = Number(cfg.rollingMaxCount);
  const max = Number.isFinite(configured) && configured > 0 ? configured : ROLLING_MAX_DEFAULT;
  if (used >= max) return null;
  // LIVE 从"有"变成"没有"无法只做加法合并，回退全量。
  if (base.liveIncluded && !liveIncluded) return null;

  const newFiles = chunkFiles.slice(base.chunkFiles.length);
  const liveChanged = liveIncluded && (!base.liveIncluded || liveSummary?.inputHash !== base.liveInputHash);
  if (!newFiles.length && !liveChanged) return null;
  return { base, newFiles, liveChanged, rollingCount: used + 1 };
}

/** 模型归并失败时的机械拼接版：保证用户拿到的永远是可读、可接续的文本。 */
function mechanicalFallbackMarkdown({ sessionTitle, chunks, liveIncluded, reason }) {
  const lines = [
    "# 1. 一句话总览",
    `${sessionTitle}：模型归并暂时失败，下面是自动拼接的段摘要与当前内容；下次准备交接会自动重试模型。`,
    "",
    "# 2. 最终结论与待办",
    "- 模型归并未完成，结论请以各段摘要和当前未压缩内容为准。",
    "- 重新准备一次交接即可得到模型精炼版。",
    "",
    "# 3. 关键决策全表",
    "见下方各段摘要。",
    "",
    "# 4. 用户偏好与硬约束",
    "见下方各段摘要。",
    "",
    "# 5. 重要产出清单",
    "见下方各段摘要中的文件路径。",
    "",
    "# 6. 时间线",
    "见下方各段标题。",
    "",
    "---",
    "",
    `> 机械拼接原因：${reason}`,
    "",
  ];
  for (const chunk of chunks) {
    lines.push(`## ${chunk.label}${chunk.file ? `（${chunk.file}）` : ""}`, "", String(chunk.text ?? "").trim(), "");
  }
  if (!liveIncluded) lines.push("> 注意：本次交接没有纳入当前未压缩内容。", "");
  return lines.join("\n");
}

export async function buildTotal({ sessionOrId, cwd, cfg = loadConfig(), onProgress = () => {} } = {}) {
  const source = getSource("zcode");
  const session = typeof sessionOrId === "string" ? source.getSession(sessionOrId) : sessionOrId;
  if (!session) throw new Error(`找不到会话: ${sessionOrId}`);
  if (cwd && !sameWorkspace(cwd, session.cwd)) throw new Error("归档工作区与会话不一致，已停止写入。");
  const workdir = session.cwd;
  const paths = store.sessionPaths(workdir, session, cfg);

  // 先做纯读取的快照检查；重复点击且内容未变化时不启动任何模型调用。
  const beforeState = store.readState(paths);
  const beforeCompactions = source.listCompactions(session.id);
  const beforeChunkFiles = store.listChunkFiles(paths.dir);
  const beforeLive = liveContent({ session, source, comps: beforeCompactions, cfg });
  const reused = reusableTotal({
    state: beforeState,
    paths,
    session,
    source,
    comps: beforeCompactions,
    chunkFiles: beforeChunkFiles,
    live: beforeLive,
    cfg,
  });
  if (reused) {
    // 只新增了被过滤的系统消息时 LIVE 正文没变、缓存仍然有效。
    // 这里只把展示用的覆盖范围推进到最新 sequence：不调模型、不重写 TOTAL、不重建索引。
    const maxSeq = beforeLive?.maxSeq ?? null;
    if (maxSeq != null && maxSeq > (beforeState.totalThroughSequence ?? -1)) {
      const merged = store.mergeState(paths, {
        ...beforeState,
        total: { ...beforeState.total, throughSequence: maxSeq },
        totalThroughSequence: maxSeq,
      });
      if (merged.total?.builtAt === beforeState.total?.builtAt) reused.throughSequence = maxSeq;
    }
    onProgress({ phase: "done", progress: 1, count: 1, reused: true });
    logEvent("total-reused", { sessionId: session.id, chunks: beforeChunkFiles.length, liveIncluded: reused.liveIncluded });
    return reused;
  }

  onProgress({ phase: "archive" });
  const scanned = await scanSession(session, { cwd: workdir, cfg, summarize: true, onProgress });
  const warnings = scanned.errors.map((item) => item.error);
  // 未归档的新边界仍包含在本次活跃区间中，避免并发压缩留下空档。
  const comps = scanned.compactions;
  const repaired = await repairFailedChunks({ session, source, paths, cfg, comps, files: beforeChunkFiles, onProgress });
  warnings.push(...repaired.errors.map((item) => item.error));
  let liveSummary = null;
  if (!cfg.skipLiveForTotal) {
    onProgress({ phase: "live", progress: null, count: null });
    liveSummary = await summarizeLive({ session, source, paths, cfg, comps });
    if (liveSummary?.warning) warnings.push(liveSummary.warning);
  } else {
    warnings.push("高级配置跳过了当前未压缩内容；本次交接可能不完整。");
  }

  const chunkFiles = store.listChunkFiles(paths.dir);
  const snapshot = chunkSnapshot(paths.dir, chunkFiles);
  const liveIncluded = Boolean(liveSummary);
  // 滚动归并的底稿来自独立 state 数据，而不是可能已经被草稿覆盖的 TOTAL.md。
  const beforeMerge = store.readState(paths);
  const plan = rollingPlan({ cfg, session, chunkFiles, snapshot, liveIncluded, liveSummary, base: beforeMerge.rollingBase });

  let chunksCache = null;
  const collectAll = () => {
    if (!chunksCache) {
      chunksCache = chunkFiles.map((file, i) => chunkEntry({ paths, file, index: i + 1, cfg, session, source, comps, warnings }));
      if (liveSummary) chunksCache.push({ label: "当前未压缩内容", file: "LIVE.md", text: liveSummary.text });
    }
    return chunksCache;
  };

  let result = null;
  let rolling = false;
  let mergeCause = null;
  let mergeInputChars = null;

  if (plan) {
    // 只提交"上一版总摘要 + 新增段 + 最新 LIVE"，一次调用完成增量归并。
    const additions = plan.newFiles.map((file, i) =>
      chunkEntry({ paths, file, index: plan.base.chunkFiles.length + i + 1, cfg, session, source, comps, warnings }),
    );
    let deltaChars = additions.reduce((n, chunk) => n + chunk.text.length, 0);
    if (plan.liveChanged && liveSummary) {
      additions.push({ label: "当前未压缩内容（最新）", file: "LIVE.md", text: liveSummary.text });
      deltaChars += liveSummary.text.length;
    }
    const budgetChars = Number(cfg.mergeBudgetChars) || 60000;
    const hardCap = Math.max(Number(cfg.maxTranscriptChars) || 0, ROLLING_HARD_CAP_CHARS);
    if (additions.length && deltaChars <= budgetChars && plan.base.body.length + deltaChars <= hardCap
      && requestFits(rollingSummaryMessages({ sessionTitle: session.title, previousBody: plan.base.body, additions }, llmOpts(cfg)), llmOpts(cfg))) {
      try {
        result = await buildRollingSummary({
          sessionTitle: session.title,
          previousBody: plan.base.body,
          additions,
          llm: llmOpts(cfg),
          onProgress,
        });
        rolling = true;
        mergeInputChars = plan.base.body.length + deltaChars;
      } catch (err) {
        // 滚动失败不再重试全量：同一波模型不可用时全量只会再失败一次。
        mergeCause = err;
        logEvent("rolling-merge-failed", { sessionId: session.id, error: shortError(err) });
      }
    }
  }

  if (!result && !mergeCause) {
    const chunks = collectAll();
    if (!chunks.length) throw new Error("当前会话还没有可整理的对话内容。");
    try {
      result = await buildTotalSummary({ sessionTitle: session.title, chunks, budgetChars: cfg.mergeBudgetChars, llm: llmOpts(cfg), onProgress });
      mergeInputChars = chunks.reduce((n, chunk) => n + chunk.text.length, 0);
    } catch (err) {
      mergeCause = err;
    }
  }

  const builtAt = new Date().toISOString();
  const chunkCount = chunkFiles.length + (liveIncluded ? 1 : 0);
  const throughSequence = liveSummary?.throughSequence ?? (comps.at(-1)?.tailSequence ?? 0) - 1;
  let body = null;
  let isFallback = false;
  let passes = 0;
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
  let rollingCount = 0;

  if (result && String(result.markdown ?? "").trim()) {
    body = String(result.markdown).trim();
    passes = result.passes;
    usage = result.usage;
    rollingCount = rolling ? plan.rollingCount : 0;
  } else {
    if (!mergeCause) mergeCause = new Error("模型返回了空内容。");
    isFallback = true;
    const reason = shortError(mergeCause);
    warnings.push(`模型归并失败，本次交接为机械拼接版，下一次准备交接会自动重试模型：${reason}`);
    body = mechanicalFallbackMarkdown({ sessionTitle: session.title, chunks: collectAll(), liveIncluded, reason });
    // 保留滚动计数：机械版不是模型结果，不能靠它绕过周期性全量重建。
    rollingCount = Number(beforeMerge.totalRollingCount) || 0;
    mergeInputChars = collectAll().reduce((n, chunk) => n + chunk.text.length, 0);
    logEvent("total-fallback", { sessionId: session.id, chunks: chunkCount, error: reason });
  }

  const modelLabel = result ? `${result.provider}/${result.model}` : "mechanical-fallback";
  const header = [
    "---", `session: ${JSON.stringify(session.id)}`, `session_title: ${JSON.stringify(session.title)}`,
    `cwd: ${JSON.stringify(workdir)}`, `chunk_count: ${chunkCount}`, `live_included: ${liveIncluded}`,
    `merge_passes: ${passes}`, `rolling: ${Boolean(rolling)}`, `fallback: ${isFallback}`,
    `model: ${JSON.stringify(modelLabel)}`,
    `tokens: in=${usage.inputTokens} out=${usage.outputTokens} total=${usage.totalTokens}`,
    `built_at: ${builtAt}`, "---", "", `# 交接文档 · ${session.title}`, "",
    ...warnings.map((warning) => `> 注意：${warning.replace(/\n/g, " ")}`), "",
  ].join("\n");
  onProgress({ phase: "save", progress: null, count: null, fallback: isFallback });
  const totalMarkdown = header + body + "\n";
  const totalPath = store.writeTotal(paths, totalMarkdown);
  const total = {
    path: totalPath, totalPath, sessionId: session.id, sessionTitle: session.title,
    chunkCount, liveIncluded, warnings, builtAt,
    handoverText: buildHandoverText(totalPath), highlights: buildHighlights(body),
    passes, usage, model: result ? modelLabel : null,
    rolling: Boolean(rolling), isFallback, isDraft: false,
    fallbackReason: isFallback ? shortError(mergeCause) : null,
    throughSequence,
  };
  const statePatch = {
    totalBuiltAt: builtAt,
    totalInputChars: mergeInputChars ?? (body?.length ?? 0),
    totalThroughSequence: throughSequence,
    totalSourceFiles: snapshot,
    totalLiveInputHash: liveSummary?.inputHash ?? null,
    totalConfigKey: totalConfigKey(cfg),
    totalRollingCount: rollingCount,
    totalContentHash: store.sha256(totalMarkdown),
    total,
  };
  if (isFallback) {
    // 机械 fallback 不覆盖 lastFinalTotal / rollingBase：下一次重试仍以最后一版成功结果做增量。
    store.mergeState(paths, statePatch);
  } else {
    store.mergeState(paths, {
      ...statePatch,
      // 独立保存最终正文：TOTAL.md 之后被草稿覆盖也不影响下一次滚动归并。
      rollingBase: {
        sessionId: session.id,
        builtAt,
        body,
        markdown: totalMarkdown,
        chunkCount,
        liveIncluded,
        liveInputHash: liveSummary?.inputHash ?? null,
        configKey: totalConfigKey(cfg),
        chunkFiles: snapshot,
        rollingCount,
        throughSequence,
      },
      lastFinalTotal: total,
    });
  }
  store.rebuildIndex(paths.root);
  logEvent("total", { sessionId: session.id, chunks: chunkCount, liveIncluded, passes, rolling, fallback: isFallback, usage });
  return total;
}

/** 从段摘要文件里抠出「## 归档摘要」正文，跳过 frontmatter 和折叠的官方摘要。 */
export function extractChunkSummary(markdown) {
  return extractSummary(markdown);
}

export { fmtTime };
