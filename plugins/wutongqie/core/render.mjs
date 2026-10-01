// 把消息/内容块渲染成 markdown。
//
// 给 LLM 看的版本要紧凑：工具只留「工具名 + 标题 + 输入摘要」，绝不带 output
// （一次 Bash 的 output 能到几万字符，会把摘要请求直接撑爆）。
// 存盘留档的原文版本会额外带一小段 output 预览，方便你自己 grep。

const TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function fmtTime(ms) {
  if (!ms) return "";
  return TIME_FMT.format(new Date(ms)).replace(/\//g, "-");
}

function fmtIso(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : TIME_FMT.format(d).replace(/\//g, "-");
}

function clamp(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断，原长 ${s.length} 字符）`;
}

/** 按工具挑最能说明"做了什么"的入参字段。 */
const HINT_FIELDS = {
  Bash: ["command"],
  Shell: ["command"],
  Read: ["file_path"],
  Write: ["file_path", "content"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  Grep: ["pattern", "path"],
  Glob: ["pattern", "path"],
  Fetch: ["url"],
  WebFetch: ["url", "prompt"],
  WebSearch: ["query"],
  Task: ["description", "prompt"],
  Agent: ["description", "prompt"],
  Skill: ["skill", "args"],
  TodoWrite: [],
};

/** 从工具入参里挑一句人类能读的描述。 */
function toolInputHint(data) {
  const input = data?.state?.input;
  if (!input) return "";
  let obj = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      return clamp(input.replace(/\s+/g, " ").trim(), 160);
    }
  }
  if (typeof obj !== "object" || obj === null) return clamp(String(obj), 160);
  if (Array.isArray(obj)) return clamp(JSON.stringify(obj).replace(/\s+/g, " "), 160);

  const flat = (v) => (typeof v === "string" ? clamp(v.replace(/\s+/g, " ").trim(), 160) : "");

  // AskUserQuestion：把第一个问题问什么直接写出来
  if (Array.isArray(obj.questions) && obj.questions.length) {
    const labels = obj.questions
      .map((qq) => (typeof qq?.question === "string" ? qq.question.split("\n")[0] : ""))
      .filter(Boolean)
      .slice(0, 3);
    if (labels.length) return flat(labels.join(" / "));
  }
  // TodoWrite：列出待办条目
  if (Array.isArray(obj.todos) && obj.todos.length) {
    return flat(obj.todos.map((t) => t?.content ?? "").filter(Boolean).join("; "));
  }

  const order = HINT_FIELDS[data?.tool] ?? ["description", "command", "file_path", "path", "pattern", "url", "query", "prompt", "name"];
  for (const f of order) {
    const v = flat(obj[f]);
    if (v) return v;
  }
  const keys = Object.keys(obj).slice(0, 4).join(", ");
  return keys ? `{${keys}}` : "";
}

function toolLine(part, { withOutput, toolOutputPreview = 240 }) {
  const d = part.data;
  if (!d) return "";
  const status = d.state?.status && d.state.status !== "completed" ? ` [${d.state.status}]` : "";
  const title = d.state?.title && d.state.title !== d.tool ? d.state.title : "";
  const hint = toolInputHint(d);
  const head = [`- 🔧 \`${d.tool}\``, title, status].filter(Boolean).join(" ");
  const bits = [head];
  if (hint) bits.push(`  - ${hint}`);
  if (withOutput) {
    const out = d.state?.output;
    if (typeof out === "string" && out.trim()) {
      const one = out.replace(/\s+/g, " ").trim();
      if (one && toolOutputPreview > 0) bits.push(`  - ↳ ${clamp(one, toolOutputPreview)}`);
    }
  }
  return bits.join("\n");
}

/**
 * 渲染一段对话。
 * @param {object} segment getSegment 的返回值
 * @param {object} opts { maxMessageChars, withToolOutput }
 */
export function renderSegment(segment, { maxMessageChars = 4000, withToolOutput = false, toolOutputPreview = 240 } = {}) {
  const out = [];
  for (const m of segment.messages) {
    if (m.special === "official-summary") {
      out.push(`\n### ⟪ 上一次压缩时 ZCode 生成的摘要 ⟫\n`);
      out.push(m.text || "(空)");
      out.push("");
      continue;
    }
    const who = m.role === "user" ? "用户" : "助手";

    // 先攒内容，全空的助手消息（只有 step-start/finish）直接跳过，不占版面
    const body = [];
    for (const part of m.parts ?? []) {
      const d = part.data;
      if (!d) continue;
      if (d.type === "text" && d.text?.trim()) {
        body.push(clamp(d.text.trim(), maxMessageChars));
      } else if (d.type === "tool") {
        body.push(toolLine(part, { withOutput: withToolOutput, toolOutputPreview }));
      } else if (d.type === "file") {
        body.push(`- 📎 附件 ${d.mime ?? ""} ${d.metadata?.fileName ?? d.url ?? ""}`.trim());
      }
      // reasoning / step-start / step-finish / timeline / compaction 一律丢弃
    }
    if (body.length === 0) {
      if (m.role === "user") body.push("_（空消息）_");
      else continue;
    }
    out.push(`\n#### ${who} · ${fmtTime(m.time)}\n`);
    out.push(body.join("\n"));
    out.push("");
  }
  return out.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

/** 估算中英混排的字符数，够用来做粗略的 token 预算。 */
export function approxTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 2);
}

/** Compatibility helper: length limits now select blocks in summarize.mjs, never delete dialogue. */
export function fitTranscript(markdown, budget) {
  const text = String(markdown ?? "");
  return { text, notes: text.length > budget ? ["正文超过单块预算，将完整分块总结"] : [], reduced: false };
}

export function chunkFilename(index, iso) {
  const d = new Date(iso);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stampStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${p(index)}-${stampStr}.md`;
}

export { fmtIso };
