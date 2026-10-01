const CHUNK_SECTIONS = [
  "目标与意图",
  "已完成事项",
  "关键决策与理由",
  "产出文件与代码位置",
  "未决问题",
  "用户偏好与硬约束",
];

export function hasChunkSummarySections(markdown) {
  const text = String(markdown ?? "");
  if (/^\s*(?:`{3,}|~{3,})/m.test(text) || /^\s*---\r?\n/.test(text)) return false;
  const headings = text.split(/\r?\n/).map((line) => {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1];
    return heading?.replace(/\*\*/g, "").trim().match(/^(\d+)[.、．]\s*(.+)$/);
  }).filter(Boolean);
  return headings.length === CHUNK_SECTIONS.length && headings.every((heading, i) =>
    Number(heading[1]) === i + 1 && heading[2].replace(/\*\*/g, "").trim() === CHUNK_SECTIONS[i],
  );
}

export function assertChunkSummarySections(markdown) {
  if (hasChunkSummarySections(markdown)) return;
  const err = new Error("模型段摘要未遵循六节结构，不能作为成功结果；原文已保留，未接受格式异常的摘要。");
  err.code = "MODEL_SUMMARY_FORMAT";
  err.retryable = false;
  throw err;
}
