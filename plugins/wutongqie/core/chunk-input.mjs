import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderSegment } from "./render.mjs";
import { requestLimits } from "./budget.mjs";
import { hasChunkSummarySections } from "./summary-schema.mjs";
import * as store from "./store.mjs";

export function extractSummary(markdown) {
  const start = markdown.indexOf("\n## 归档摘要\n");
  let body = start >= 0 ? markdown.slice(start + "\n## 归档摘要\n".length) : markdown;
  const details = body.indexOf("\n<details>");
  if (details >= 0) body = body.slice(0, details);
  return body.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export function failedSummary(body) {
  return !body.trim() || /^_摘要生成失败/.test(body);
}

export function summaryConfigKey(cfg) {
  const limits = requestLimits({ contextTokens: cfg.summaryContextTokens, maxOutputTokens: cfg.summaryOutputTokens });
  return JSON.stringify({
    version: 3,
    provider: cfg.llmProviderId ?? "",
    model: cfg.llmModelId ?? "",
    context: limits.context,
    output: limits.output,
    maxTranscriptChars: cfg.maxTranscriptChars ?? null,
    maxMessageChars: cfg.maxMessageChars ?? null,
    toolOutputPreview: cfg.toolOutputPreview ?? 240,
  });
}

export function validRepair(paths, file, cfg, archivedText) {
  const repair = store.readRepair(paths, file);
  if (!repair || repair.configKey !== summaryConfigKey(cfg) || repair.sourceHash !== store.sha256(archivedText)) return null;
  return typeof repair.text === "string" && hasChunkSummarySections(repair.text) ? repair : null;
}

export function needsRepair(paths, file, cfg) {
  const text = readFileSync(join(paths.dir, file), "utf8");
  return failedSummary(extractSummary(text)) && !validRepair(paths, file, cfg, text);
}

export function archivedChunkText(paths, file, cfg) {
  const text = store.readChunkText(paths, file);
  if (!/^\d{2,}-\d{8}-\d{4}\.md$/.test(file) || !failedSummary(extractSummary(text))) return text;
  const repair = validRepair(paths, file, cfg, text);
  if (!repair) return text;
  const marker = "\n## 归档摘要\n";
  const start = text.indexOf(marker);
  if (start < 0) return `> 这是修复后的摘要，原始归档文件保持不变。\n\n${repair.text}`;
  const details = text.indexOf("\n<details>", start + marker.length);
  return `${text.slice(0, start)}${marker}\n> 摘要已修复；原始归档文件保持不变，修复结果独立保存。\n\n${repair.text}\n${details < 0 ? "" : text.slice(details)}`;
}

/** Recover the complete dialogue body; tool output remains an explicitly bounded preview. */
export function recoverChunk({ paths, file, archivedText, session, source, comps, cfg }) {
  const id = archivedText.match(/^boundary_id: "([^"]+)"/m)?.[1];
  const position = comps.findIndex((item) => item.boundaryId === id);
  const boundary = comps[position];
  const lower = position > 0 ? comps[position - 1].tailSequence - 1 : -1;
  const rawPath = join(paths.rawDir, file);
  let text = "";
  let origin = "database";
  if (existsSync(rawPath)) {
    text = readFileSync(rawPath, "utf8");
    origin = "raw";
    const oldStart = Number(archivedText.match(/^message_range: "(\d+)\.\./m)?.[1]);
    if (position > 0 && oldStart === comps[position - 1].tailSequence + 1) {
      const retained = source.getSegment(session.id, lower, lower + 2);
      text = renderSegment(retained, { maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240 }) + "\n\n" + text;
    }
  } else if (boundary) {
    text = renderSegment(source.getSegment(session.id, lower, boundary.tailSequence), {
      maxMessageChars: Infinity, withToolOutput: true, toolOutputPreview: cfg.toolOutputPreview ?? 240,
    });
  }
  if (!text.trim()) {
    text = boundary?.officialSummary ?? "";
    origin = "official";
  }
  if (!text.trim()) throw new Error(`历史记录 ${file} 无法从会话中恢复，不能生成完整交接。`);
  return { text, origin, boundary, sourceHash: store.sha256(archivedText) };
}
