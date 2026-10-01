// 路径解析与配置。所有进程（hook / MCP / 面板）都从这里取路径，保证一致。
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const here = fileURLToPath(import.meta.url);

export const PLUGIN_ROOT = resolve(here, "..", "..");
export const ZCODE_HOME = join(homedir(), ".zcode");
export const ZCODE_DB = join(ZCODE_HOME, "cli", "db", "db.sqlite");
export const PROVIDER_CONFIG = join(ZCODE_HOME, "v2", "provider_config.json");
export const LEGACY_PROVIDER_CONFIG = join(ZCODE_HOME, "v2", "config.json");

// 插件数据目录：hook 会注入 ZCODE_PLUGIN_DATA；MCP/面板由 manifest 传入；都没有时回退到 inline 约定路径。
export const PLUGIN_DATA =
  process.env.ZCODE_PLUGIN_DATA && process.env.ZCODE_PLUGIN_DATA.trim()
    ? resolve(process.env.ZCODE_PLUGIN_DATA.trim())
    : join(ZCODE_HOME, "cli", "plugins", "data", "wutongqie@inline");

export const CONFIG_FILE = join(PLUGIN_DATA, "config.json");
export const PANEL_FILE = join(PLUGIN_DATA, "panel.json");
export const LOG_FILE = join(PLUGIN_DATA, "archive.log.jsonl");

export const OUTPUT_DIRNAME = ".无痛切";

export const DEFAULTS = {
  // 归档根目录；空字符串表示"每个工作区各自的 <cwd>/.无痛切"
  outputRoot: "",
  // 是否额外保存被压缩掉的原文（正文不截断，工具输出只保留有界预览）
  saveRaw: true,
  // 兼容字段：旧版单条消息正文截断长度。新摘要正文不再截断，保留只为旧配置可读
  maxMessageChars: 4000,
  // 工具 output 在正文/原文里的有界预览长度（喂给 LLM 时同样只带预览）
  toolOutputPreview: 240,
  // 压缩归档时是否向对话播报。false = 完全静默，只在出错或总摘要完成时说
  announce: false,
  // 空字符串 = 自动挑选 provider / model
  llmProviderId: "",
  llmModelId: "",
  llmTimeoutMs: 180000,
  // 总摘要分层归并的单层字符预算
  mergeBudgetChars: 60000,
  // 单次摘要请求允许的最大原文字符数；超过了自动分块，不再裁剪正文
  maxTranscriptChars: 180000,
  // 单次摘要请求的安全上下文预算（token 估算值，非精确 tokenizer）
  summaryContextTokens: 65536,
  // 单次摘要请求的 max_tokens 输出上限，由供应商执行
  summaryOutputTokens: 8192,
  // 面板端口，0 = 自动
  panelPort: 0,
  // 生成总摘要时是否纳入"仍未被压缩的活跃段"。默认纳入，否则换会话会丢掉这段
  skipLiveForTotal: false,
};

const BOOL_KEYS = new Set(["saveRaw", "announce", "skipLiveForTotal"]);
const NUM_KEYS = new Set([
  "maxMessageChars",
  "toolOutputPreview",
  "llmTimeoutMs",
  "mergeBudgetChars",
  "maxTranscriptChars",
  "summaryContextTokens",
  "summaryOutputTokens",
  "panelPort",
]);

// 摘要预算：上下文预算必须大于输出预算，并给 1024 预留 + 512 余量留空间。
// 与 core/budget.mjs 的 requestLimits() 保持一致；不满足时回退到默认预算。
export const SUMMARY_BUDGET_MARGIN = 1536;

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (!Number.isSafeInteger(i) || i <= 0) return fallback;
  return i;
}

/** 把摘要预算规整成合法组合：两个正整数 token，且 context > output + 1536。 */
function normalizeSummaryBudget(cfg) {
  const context = positiveInt(cfg.summaryContextTokens, DEFAULTS.summaryContextTokens);
  const output = positiveInt(cfg.summaryOutputTokens, DEFAULTS.summaryOutputTokens);
  if (context <= output + SUMMARY_BUDGET_MARGIN) {
    return { summaryContextTokens: DEFAULTS.summaryContextTokens, summaryOutputTokens: DEFAULTS.summaryOutputTokens };
  }
  return { summaryContextTokens: context, summaryOutputTokens: output };
}

function coerce(key, value) {
  if (BOOL_KEYS.has(key)) return Boolean(value);
  if (NUM_KEYS.has(key)) {
    if (key === "summaryContextTokens" || key === "summaryOutputTokens") return positiveInt(value, DEFAULTS[key]);
    const n = Number(value);
    return Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return value == null ? DEFAULTS[key] : String(value);
}

export function loadConfig() {
  let fileCfg = {};
  try {
    if (existsSync(CONFIG_FILE)) fileCfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    fileCfg = {};
  }
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (fileCfg[key] !== undefined) cfg[key] = coerce(key, fileCfg[key]);
  }
  // manifest userConfig 经 env 传入，优先级最高
  const envMap = {
    outputRoot: "WTQ_OUTPUT_ROOT",
    llmProviderId: "WTQ_LLM_PROVIDER_ID",
    llmModelId: "WTQ_LLM_MODEL_ID",
  };
  for (const [key, env] of Object.entries(envMap)) {
    if (process.env[env]) cfg[key] = process.env[env];
  }
  for (const key of BOOL_KEYS) {
    if (process.env[`WTQ_${key.toUpperCase()}`] !== undefined) cfg[key] = process.env[`WTQ_${key.toUpperCase()}`] !== "false";
  }
  // 读到的旧配置/手改配置可能非法：保证返回的摘要预算始终可用
  Object.assign(cfg, normalizeSummaryBudget(cfg));
  return cfg;
}

export function saveConfig(patch) {
  mkdirSync(PLUGIN_DATA, { recursive: true });
  const merged = { ...loadConfig(), ...patch };
  const next = {};
  for (const key of Object.keys(DEFAULTS)) next[key] = coerce(key, merged[key]);
  // 落盘的配置同样必须合法（非法组合回退默认预算），面板拿到的也是规范化后的值
  Object.assign(next, normalizeSummaryBudget(next));
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = next[key];
  writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}

/** 归档根目录。config.outputRoot 为空时落在工作区自己的 .无痛切/ 下。 */
export function outputRootFor(cwd, cfg = loadConfig()) {
  if (cfg.outputRoot && cfg.outputRoot.trim()) {
    const root = cfg.outputRoot.trim();
    return isAbsolute(root) ? root : resolve(cwd, root);
  }
  return join(cwd, OUTPUT_DIRNAME);
}

export function logEvent(event, detail) {
  try {
    mkdirSync(PLUGIN_DATA, { recursive: true });
    writeFileSync(
      LOG_FILE,
      JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n",
      { flag: "a" },
    );
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

export function readLog(limit = 200) {
  try {
    if (!existsSync(LOG_FILE)) return [];
    return readFileSync(LOG_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
