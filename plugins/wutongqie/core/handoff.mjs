// 标题解析失败只影响要点预览，不影响交接文档生成。

const SECTION_PATTERNS = {
  overview: /^1\s*[.、]\s*一句话总览/i,
  conclusions: /^2\s*[.、]\s*最终结论与待办/i,
  constraints: /^4\s*[.、]\s*用户偏好与硬约束/i,
};

function clean(value) {
  return String(value ?? "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function sectionBody(markdown, pattern) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  let start = -1;
  let level = 1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match && pattern.test(match[2].replace(/\*\*/g, "").trim())) {
      start = i + 1;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return clean(lines.slice(start, end).join("\n"));
}

export function buildHighlights(markdown) {
  return {
    overview: sectionBody(markdown, SECTION_PATTERNS.overview),
    conclusions: sectionBody(markdown, SECTION_PATTERNS.conclusions),
    constraints: sectionBody(markdown, SECTION_PATTERNS.constraints),
  };
}

export function buildHandoverText(totalPath) {
  return [
    "继续之前的工作。请先读取以下交接文档：",
    String(totalPath ?? "TOTAL.md"),
    "读取后先告诉我当前进展、未完成事项和下一步建议。",
  ].join("\n");
}

export function hasHighlights(highlights) {
  return Boolean(highlights?.overview || highlights?.conclusions || highlights?.constraints);
}
