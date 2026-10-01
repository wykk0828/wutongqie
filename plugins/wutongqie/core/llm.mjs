// 直接复用 ZCode 自己的 provider 配置调模型，不额外要 API key。
//
// ZCode 的 provider 定义在 ~/.zcode/v2/provider_config.json：
//   config.providerConfigRules.providerRules[].config.access.apiKey   —— 密钥
//   config.providerConfigRules.providerRules[].config.api            —— { type, baseUrl }
//   config.providerOrder                                                —— 优先级
// 另有 ~/.zcode/v2/config.json 里 provider.<id>.options.apiKey 作为兜底来源。
//
// 只支持 openai-chat-completions（ZCode 用的就是 OpenAI 兼容的 /chat/completions）。
import { readFileSync, existsSync } from "node:fs";
import { PROVIDER_CONFIG, LEGACY_PROVIDER_CONFIG } from "./config.mjs";

function readJsonSafe(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

function legacyKey(providerId) {
  const legacy = readJsonSafe(LEGACY_PROVIDER_CONFIG);
  const key = legacy?.provider?.[providerId]?.options?.apiKey;
  return typeof key === "string" && key ? key : "";
}

/** 列出所有可用于摘要的 provider，按 ZCode 的优先级排序。 */
export function listProviders() {
  const cfg = readJsonSafe(PROVIDER_CONFIG);
  if (!cfg) return [];
  const rules = cfg.config?.providerConfigRules?.providerRules ?? [];
  const byId = new Map(rules.map((r) => [r.providerId, r]));
  const order = Array.isArray(cfg.config?.providerOrder) ? cfg.config.providerOrder : rules.map((r) => r.providerId);

    const out = [];
    for (const id of order) {
      const rule = byId.get(id);
      if (!rule) continue;
      const c = rule.config ?? {};
      const apiType = c.api?.type;
      const baseUrl = (c.api?.baseUrl ?? "").replace(/\/+$/, "");
      const apiKey = c.access?.apiKey || legacyKey(id);
      if (!baseUrl) continue;
      const models = (c.personalModelIds ?? []).filter(Boolean);
      const modelOrder = (c.modelOrder ?? []).filter((m) => models.includes(m));
      out.push({
        providerId: id,
        name: rule.providerName ?? id,
        enabled: rule.enabled !== false,
        apiType,
        baseUrl,
        hasKey: Boolean(apiKey),
        usable: apiType === "openai-chat-completions" && Boolean(apiKey) && Boolean(baseUrl),
        models: modelOrder.length ? modelOrder : models,
        // 只回传掩码便于排查
        keyHint: apiKey ? "已配置" : "",
      });
      // 密钥要跟着对象走：只存在于 provider_config.json 的供应商，在 v2/config.json
      // 里查不到，调用时再找一次就会误判成"没有密钥"。定义成不可枚举属性，
      // 这样任何意外的 JSON.stringify / 对象展开都不会把它带出去。
      Object.defineProperty(out[out.length - 1], "apiKey", { value: apiKey, enumerable: false });
    }
    return out;
}

function withModel(provider, modelId) {
  const selected = { ...provider, modelId };
  Object.defineProperty(selected, "apiKey", { value: provider.apiKey, enumerable: false });
  return selected;
}

/** 选出实际要用的 provider + model。显式指定优先，否则按优先级取第一个可用的。 */
export function pickProvider({ providerId = "", modelId = "" } = {}) {
  const all = listProviders();
  if (providerId) {
    const p = all.find((x) => x.providerId === providerId);
    if (!p) throw new Error(`配置里的 provider 不存在: ${providerId}`);
    if (!p.usable) {
      throw new Error(
        `provider ${p.name} 不可用（apiType=${p.apiType ?? "?"}，有密钥=${p.hasKey}）。` +
          `本插件只支持 openai-chat-completions 类型的 provider。`,
      );
    }
    return withModel(p, modelId || p.models[0] || "");
  }
  const usable = all.filter((p) => p.usable);
  // 被禁用的 provider 排到最后，只在实在没别的选择时才用
  const ranked = [...usable.filter((p) => p.enabled), ...usable.filter((p) => !p.enabled)];
  if (ranked.length === 0) {
    throw new Error(
      "在 ~/.zcode/v2/provider_config.json 里找不到任何可用的 openai-chat-completions provider。" +
        "请在 ZCode 设置里配置一个带 API key 的供应商。",
    );
  }
  return withModel(ranked[0], modelId || ranked[0].models[0] || "");
}

function endpoint(baseUrl) {
  return /\/chat\/completions$/.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
}

/** 429/5xx/524 这类网关抖动值得重试；4xx 权限/格式错误重试也没用。 */
function retryable(status) {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/**
 * finish_reason === "length"：模型被输出上限/上下文硬截断。
 * 即使已经产出部分正文，也绝不能当成功结果落盘——上层应缩小输入分块后重试。
 * 可识别标记：err.code === "MODEL_OUTPUT_TRUNCATED" / err.truncated === true / instanceof。
 */
export class ModelOutputTruncatedError extends Error {
  constructor(message, { providerId = "", modelId = "", finishReason = "length", partialText = "", maxOutputTokens = null, usage = null } = {}) {
    super(message);
    this.name = "ModelOutputTruncatedError";
    this.code = "MODEL_OUTPUT_TRUNCATED";
    this.truncated = true;
    // 重发同一个请求只会再烧一次 token 并再次截断，因此同模型明确不可重试。
    this.retryable = false;
    this.finishReason = finishReason;
    // 部分正文仅供日志/排查，禁止当作成功结果保存。
    this.partialText = partialText;
    this.partialChars = partialText.length;
    this.maxOutputTokens = maxOutputTokens;
    this.providerId = providerId;
    this.modelId = modelId;
    this.usage = usage;
  }
}

/**
 * 只返回了 reasoning_content（思考过程）、没有正文。
 * 推理不等于答案，按失败处理；同模型重发同样请求基本无意义，也不重试。
 * 可识别标记：err.code === "MODEL_REASONING_ONLY" / err.reasoningOnly === true。
 */
export class ModelReasoningOnlyError extends Error {
  constructor(message, { providerId = "", modelId = "", finishReason = null, reasoningChars = 0, usage = null } = {}) {
    super(message);
    this.name = "ModelReasoningOnlyError";
    this.code = "MODEL_REASONING_ONLY";
    this.reasoningOnly = true;
    this.retryable = false;
    this.finishReason = finishReason;
    this.reasoningChars = reasoningChars;
    this.providerId = providerId;
    this.modelId = modelId;
    this.usage = usage;
  }
}

/**
 * maxOutputTokens 归一化：null/undefined/"" = 不发送 max_tokens（沿用服务端默认）；
 * 非正数或缺值直接报错，避免"以为设了输出上限其实没设"。
 */
function normalizeMaxOutputTokens(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`maxOutputTokens 必须是正数（收到 ${JSON.stringify(value)}）`);
  return Math.floor(n);
}

async function callOnce(provider, messages, timeoutMs, attempt = 1, maxTokens = null) {
  const apiKey = provider.apiKey || legacyKey(provider.providerId);
  if (!apiKey) throw new Error(`provider ${provider.providerId} 没有可用密钥`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      model: provider.modelId,
      messages,
      stream: false,
    };
    // OpenAI 兼容的输出上限；不传就不带这个字段（有的模型默认 INF = 不设限）。
    if (maxTokens) body.max_tokens = maxTokens;
    const res = await fetch(endpoint(provider.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`响应不是合法 JSON: ${text.slice(0, 300)}`);
    }
    const choice = json?.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const finishReason = choice.finish_reason ?? null;
    const usage = {
      inputTokens: json?.usage?.prompt_tokens ?? null,
      outputTokens: json?.usage?.completion_tokens ?? null,
      totalTokens: json?.usage?.total_tokens ?? null,
    };
    // 正文提取：字符串优先；content 为空时兼容数组形态（少数网关返回 [{text}]）。
    let content = typeof msg.content === "string" ? msg.content : "";
    if (!content.trim() && Array.isArray(msg.content)) {
      content = msg.content.map((c) => c?.text ?? "").join("");
    }
    // reasoning_content 是思考过程，只在正文缺失时用来判断失败原因，绝不当作最终答案。
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    const where = { providerId: provider.providerId, modelId: provider.modelId, finishReason, usage };

    if (finishReason === "length") {
      // 被截断：正文再漂亮也是半截，必须当失败抛出去，不能落盘成"成功摘要"。
      throw new ModelOutputTruncatedError(
        `模型输出被截断（finish_reason=length${maxTokens ? `，请求 max_tokens=${maxTokens}` : ""}）：` +
          `已产出正文 ${content.trim().length} 字，不能作为成功结果；需要完整缩块重试或调整输出预算。`,
        { ...where, partialText: content, maxOutputTokens: maxTokens },
      );
    }
    if (!content.trim()) {
      if (reasoning.trim()) {
        throw new ModelReasoningOnlyError(
          `模型只返回了 reasoning_content（${reasoning.length} 字），没有正文；推理过程不等于答案。`,
          { ...where, reasoningChars: reasoning.length },
        );
      }
      const reason = finishReason ?? json?.error?.message ?? "(空回复)";
      const err = new Error(`模型没有返回正文: ${reason}`);
      err.code = "MODEL_EMPTY_REPLY";
      err.finishReason = finishReason;
      err.usage = usage;
      err.retryable = false;
      throw err;
    }
    return { text: content, finishReason, usage, modelId: json?.model ?? provider.modelId };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调一次模型。默认 provider 失败时按优先级自动降级到下一个可用 provider。
 * 网关抖动（429/5xx）先原地重试，重试仍失败才降级；4xx/截断不重试。
 *
 * 输出完整性约定：
 *   - maxOutputTokens：透传为 OpenAI 兼容的 max_tokens；不传则请求体里不带该字段。
 *   - finish_reason === "length"：抛 ModelOutputTruncatedError，不保存为成功，也不再拿同一请求
 *     去试别的模型（输入太长/output 预算不够，换模型解决不了，只会重复烧 token），
 *     由上层缩小输入分块后重试。
 *   - 只有 reasoning_content、没有正文：抛 ModelReasoningOnlyError，视失败（同模型不重试，
 *     但仍会继续走降级链，因为别的模型未必犯同样的毛病）。
 * @param {object} [options]
 * @param {number|null} [options.maxOutputTokens] 输出上限；正数，null/undefined 表示不发送 max_tokens
 * @returns {Promise<{text, finishReason, usage, providerId, providerName, modelId, attempts}>}
 */
export async function complete(messages, {
  providerId = "",
  modelId = "",
  timeoutMs = 180000,
  fallback = true,
  retries = 2,
  maxOutputTokens = null,
} = {}) {
  const maxTokens = normalizeMaxOutputTokens(maxOutputTokens);
  const chosen = pickProvider({ providerId, modelId });
  const attempts = [];
  const chain = [chosen];

  if (fallback && !providerId) {
    // 降级链：同 provider 的其他模型 -> 其他可用 provider（禁用的排最后）
    for (const p of listProviders().filter((x) => x.usable)) {
      if (p.providerId === chosen.providerId) {
        for (const m of p.models) if (m !== chosen.modelId) chain.push(withModel(p, m));
      } else if (p.enabled) {
        chain.push(withModel(p, modelId || p.models[0] || ""));
      }
    }
    for (const p of listProviders().filter((x) => x.usable && !x.enabled && x.providerId !== chosen.providerId)) {
      chain.push(withModel(p, modelId || p.models[0] || ""));
    }
  }

  let lastErr = null;
  for (const p of chain) {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const r = await callOnce(p, messages, timeoutMs, attempt, maxTokens);
        attempts.push({ provider: p.providerId, model: p.modelId, ok: true, attempt });
        return { ...r, providerId: p.providerId, providerName: p.name, attempts };
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message ?? err);
        const truncated = err?.truncated === true;
        const reasoningOnly = err?.reasoningOnly === true;
        // 截断/只推理不是网关抖动：拿同样的输入重发只会再烧一次 token。
        const canRetry = attempt <= retries && !truncated && !reasoningOnly && (retryable(err?.status) || err?.retryable);
        attempts.push({
          provider: p.providerId,
          model: p.modelId,
          ok: false,
          attempt,
          truncated,
          reasoningOnly,
          retrying: canRetry,
          error: msg.slice(0, 200),
        });
        if (truncated) {
          // 上层只能缩分完整输入，不能拿半截正文继续归并。
          err.attempts = attempts;
          throw err;
        }
        if (!canRetry) break;
        await sleep(1200 * attempt);
      }
    }
  }
  const detail = attempts.map((a) => `  · ${a.provider}/${a.model} (第${a.attempt}次): ${a.ok ? "ok" : a.error}`).join("\n");
  const err = new Error(`所有可用的模型都调用失败：\n${detail}\n最后一次错误: ${lastErr?.message ?? lastErr}`);
  err.code = lastErr?.code ?? "MODEL_ALL_FAILED";
  err.attempts = attempts;
  err.lastError = lastErr;
  err.usage = lastErr?.usage ?? null;
  if (lastErr?.retryable === false) err.retryable = false;
  if (lastErr?.reasoningOnly === true) err.reasoningOnly = true;
  throw err;
}
