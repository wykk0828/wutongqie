// 无模型交接草稿：只拼接已经落盘的摘要、待归档区间和当前 LIVE 原文。
// 草稿用于让用户先拿到可复制内容；正式 TOTAL 仍由后台模型归并覆盖。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getSource } from "./sources/index.mjs";
import { renderSegment } from "./render.mjs";
import { extractSummary, failedSummary, validRepair, recoverChunk } from "./chunk-input.mjs";
import * as store from "./store.mjs";
import { loadConfig } from "./config.mjs";
import { buildHighlights, buildHandoverText } from "./handoff.mjs";
import { sameWorkspace } from "./current-session.mjs";

function liveContent(session, source, compactions, cfg) {
  const fromSeq = compactions.length ? compactions.at(-1).tailSequence - 1 : -1;
  const maxSeq = source.maxSequence(session.id);
  const segment = source.getSegment(session.id, fromSeq, maxSeq + 1);
  const transcript = renderSegment(segment, { maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240 });
  return transcript.trim() ? { segment, transcript, maxSeq } : null;
}

function pendingContent(session, source, compactions, processed, cfg) {
  const pending = [];
  for (const boundary of compactions) {
    if (processed.has(boundary.boundaryId)) continue;
    const position = compactions.indexOf(boundary);
    const previous = position > 0 ? compactions[position - 1] : null;
    const fromSeq = previous ? previous.tailSequence - 1 : -1;
    if (typeof boundary.tailSequence !== "number" || boundary.tailSequence <= fromSeq + 1) continue;
    const segment = source.getSegment(session.id, fromSeq, boundary.tailSequence);
    const rendered = renderSegment(segment, { maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240 });
    if (!rendered.trim() && !boundary.officialSummary) continue;
    pending.push({
      boundaryId: boundary.boundaryId,
      time: boundary.time,
      text: rendered.trim() || String(boundary.officialSummary ?? "").trim(),
      notes: [],
    });
  }
  return pending;
}

function draftMarkdown({ session, chunks, pending, live, warnings, builtAt }) {
  const lines = [
    "---",
    `draft: true`,
    `session: ${JSON.stringify(session.id)}`,
    `session_title: ${JSON.stringify(session.title)}`,
    `chunk_count: ${chunks.length}`,
    `pending_count: ${pending.length}`,
    `live_included: ${Boolean(live)}`,
    `built_at: ${builtAt}`,
    "---",
    "",
    `# 交接文档草稿 · ${session.title}`,
    "",
    "> 这是可立即复制的未精炼交接草稿。后台任务会继续归档和整理，完成后用最终版本覆盖本文件。",
    "> 草稿内容比旧版 TOTAL.md 更新；若后台任务失败，本文件仍可直接使用。",
    ...warnings.map((warning) => `> 注意：${String(warning).replace(/\n/g, " ")}`),
    "",
    "# 1. 一句话总览",
    "当前交接已生成机械草稿；下面保留已归档摘要、待归档内容和当前未压缩对话，供新会话先恢复工作。",
    "",
    "# 2. 最终结论与待办",
    pending.length ? `- 后台仍需归档 ${pending.length} 个压缩边界，并用模型整理最终交接。` : "- 后台会继续用模型完善这份交接文档。",
    "- 接手后请先阅读本文件，再根据下方最新对话内容继续工作。",
    "",
    "# 3. 关键决策全表",
    "当前为机械草稿，关键决策保留在下面各段摘要和原文中；最终版会合并去重。",
    "",
    "# 4. 用户偏好与硬约束",
    "当前为机械草稿，尚未进行跨段提取；请先以已归档段和当前对话原文为准。",
    "",
    "# 5. 重要产出清单",
    "请以各段摘要中的文件路径和当前工作区实际文件为准。",
    "",
    "# 6. 时间线",
  ];

  for (const chunk of chunks) {
    lines.push("", `## ${chunk.label}`, "", chunk.text.trim() || "（无摘要正文）");
  }
  for (const item of pending) {
    lines.push(
      "",
      `## 待归档压缩段 · ${item.time || item.boundaryId}`,
      "",
      item.notes?.length ? `> 原文已压缩：${item.notes.join("；")}` : "",
      item.text,
    );
  }
  if (live) {
    lines.push("", "## 当前未压缩内容", "", live.transcript.trim());
  }
  return lines.filter((line, index) => !(line === "" && lines[index - 1] === "")).join("\n").trim() + "\n";
}

export function createDraft({ sessionOrId, cwd, cfg = loadConfig(), warnings = [] } = {}) {
  const startedAt = Date.now();
  const source = getSource("zcode");
  const session = typeof sessionOrId === "string" ? source.getSession(sessionOrId) : sessionOrId;
  if (!session) throw new Error(`找不到会话: ${sessionOrId}`);
  if (cwd && !sameWorkspace(cwd, session.cwd)) throw new Error("归档工作区与会话不一致，已停止写入。");

  const paths = store.sessionPaths(session.cwd, session, cfg);
  store.writeRootReadme(paths);
  store.writeMeta(paths, session);
  const state = store.readState(paths);
  const compactions = source.listCompactions(session.id);
  const processed = new Set(state.processed);
  const chunkFiles = store.listChunkFiles(paths.dir);
  const chunks = chunkFiles.map((file, index) => {
    const markdown = readFileSync(join(paths.dir, file), "utf8");
    let text = extractSummary(markdown);
    if (failedSummary(text)) {
      const repair = validRepair(paths, file, cfg, markdown);
      if (repair) text = repair.text;
      else {
        try {
          text = recoverChunk({ paths, file, archivedText: markdown, session, source, comps: compactions, cfg }).text;
        } catch (err) {
          warnings.push(String(err?.message ?? err));
        }
      }
    }
    return { label: `第 ${index + 1} 段`, file, text };
  });
  // 草稿只做只读渲染：未处理的压缩边界绝不能被标记为 processed，
  // 否则后台正式 scan 会跳过它们、永久丢失归档。
  const pending = pendingContent(session, source, compactions, processed, cfg);
  const live = liveContent(session, source, compactions, cfg);
  const builtAt = new Date().toISOString();
  const markdown = draftMarkdown({ session, chunks, pending, live, warnings, builtAt });
  const previousFinal = (state.total && !state.total.isFallback && !state.total.isDraft ? state.total : null) ?? state.lastFinalTotal ?? null;
  const draft = {
    path: paths.total,
    totalPath: paths.total,
    sessionId: session.id,
    sessionTitle: session.title,
    chunkCount: chunks.length + pending.length + (live ? 1 : 0),
    liveIncluded: Boolean(live),
    warnings: [...warnings, "这是未精炼草稿，后台完成后会自动替换为最终交接。"],
    builtAt,
    handoverText: buildHandoverText(paths.total),
    highlights: buildHighlights(markdown),
    passes: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 },
    model: null,
    throughSequence: live?.maxSeq ?? (compactions.at(-1)?.tailSequence ?? 0) - 1,
    isDraft: true,
    isFallback: false,
    pendingCount: pending.length,
  };

  // 竞态 1：草稿构造期间后台已经发布了更新的最终版 → 草稿不许覆盖它，文件也不写。
  const latest = store.readState(paths);
  const latestFinalAt = Math.max(
    store.stateTime(latest.totalBuiltAt ?? latest.total?.builtAt),
    store.stateTime(latest.lastFinalTotal?.builtAt),
  );
  if (latest.total && !latest.total.isFallback && !latest.total.isDraft && latestFinalAt > startedAt && store.hasTotal(paths)) {
    const merged = store.mergeState(paths, { lastFinalTotal: previousFinal ?? latest.lastFinalTotal ?? null });
    return { draft: { ...latest.total, reused: true, isDraft: false }, reusedFinal: true, paths, state: merged, compactions, pending, live };
  }

  // 竞态 2：草稿写文件的同一瞬间，后台在写最终版。先记下被我们覆盖掉的内容，
  // 写完 state 后如果发现覆盖的是更新的最终版，就把它原样写回去。
  const beforeText = store.readTotalText(paths);
  const beforeHash = beforeText == null ? null : store.sha256(beforeText);
  store.writeTotal(paths, markdown);
  // scan 可能同时更新 processed/chunkIndex/LIVE；mergeState 只增不减，且交接结果按
  // builtAt 取新，早先读到的旧 state 不会覆盖新的 final。
  const merged = store.mergeState(paths, {
    draft,
    draftBuiltAt: builtAt,
    lastFinalTotal: previousFinal ?? latest.lastFinalTotal ?? null,
  });
  const newestFinalAt = Math.max(
    store.stateTime(merged.totalBuiltAt ?? merged.total?.builtAt),
    store.stateTime(merged.lastFinalTotal?.builtAt),
  );
  if (newestFinalAt > store.stateTime(builtAt) && merged.totalContentHash) {
    const savedMarkdown = merged.rollingBase?.markdown;
    const restoreText = beforeHash === merged.totalContentHash ? beforeText
      : typeof savedMarkdown === "string" && store.sha256(savedMarkdown) === merged.totalContentHash ? savedMarkdown : null;
    if (store.totalContentHash(paths) === merged.totalContentHash || restoreText != null) {
      if (store.totalContentHash(paths) !== merged.totalContentHash) store.writeTotal(paths, restoreText);
      return { draft: { ...merged.total, reused: true, isDraft: false }, reusedFinal: true, paths, state: merged, compactions, pending, live };
    }
  }
  return { draft, paths, state: merged, compactions, pending, live };
}

export function readDraft(paths) {
  const state = store.readState(paths);
  return state.draft ?? null;
}
