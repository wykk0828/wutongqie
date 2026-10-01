// Token estimates are conservative heuristics, not a model-specific tokenizer.
export const DEFAULT_CONTEXT_TOKENS = 65536;
export const DEFAULT_OUTPUT_TOKENS = 8192;
const REQUEST_RESERVE_TOKENS = 1024;

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 2);
}

export function messagesTokens(messages) {
  return 32 + messages.reduce((total, message) => total + 16 + estimateTokens(message.role) + estimateTokens(message.content), 0);
}

export function requestLimits(llm = {}) {
  const context = Number(llm.contextTokens ?? DEFAULT_CONTEXT_TOKENS);
  const output = Number(llm.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS);
  if (!Number.isSafeInteger(context) || !Number.isSafeInteger(output) || output < 1 || context <= output + REQUEST_RESERVE_TOKENS + 512) {
    throw new Error("摘要上下文预算必须大于输出预算，并至少预留 1536 tokens。请检查高级设置。");
  }
  return { context, output, input: context - output - REQUEST_RESERVE_TOKENS };
}

export function requestFits(messages, llm = {}) {
  return messagesTokens(messages) <= requestLimits(llm).input;
}

export function assertRequestFits(messages, llm = {}) {
  if (!requestFits(messages, llm)) throw new Error("摘要请求超过输入预算，需要继续分块。");
}

function safeEnd(text, end) {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** Split without deleting any character; the prompt overhead counts toward every block. */
export function splitForMessages(text, makeMessages, llm = {}, maxChars = Infinity) {
  const input = String(text ?? "");
  const cap = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : Infinity;
  if (!requestFits(makeMessages(""), llm)) throw new Error("摘要提示词本身超过输入预算，请增大上下文预算或减少参考信息。");
  if (!input) return [""];
  const blocks = [];
  let offset = 0;
  while (offset < input.length) {
    let low = 0;
    let high = Math.min(input.length - offset, cap);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const end = safeEnd(input, offset + mid);
      if (requestFits(makeMessages(input.slice(offset, end)), llm)) low = mid;
      else high = mid - 1;
    }
    let end = safeEnd(input, offset + low);
    if (end <= offset) throw new Error("摘要输入预算过小，无法容纳正文。");
    if (end < input.length) {
      const newline = input.lastIndexOf("\n", end - 1);
      if (newline >= offset + Math.floor((end - offset) * 0.6)) end = newline + 1;
    }
    const block = input.slice(offset, end);
    assertRequestFits(makeMessages(block), llm);
    blocks.push(block);
    offset = end;
  }
  return blocks;
}
