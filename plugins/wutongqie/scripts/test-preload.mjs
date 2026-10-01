// 无痛切测试夹具预加载（配合 tests.handoff.mjs 使用）。
//
// 用法（两种都行）：
//   node --import ./scripts/test-preload.mjs <被测脚本>     # CLI 显式预加载
//   NODE_OPTIONS="--import=file:///.../test-preload.mjs" node <被测脚本>
//     —— 后者能让插件自己 spawn 的子进程（core/worker.mjs、core/panel-cli.mjs）也继承夹具，
//        因为 jobs.startWorker / ensurePanel 是裸 spawn(process.execPath, ...)，不会带 --import。
//
// 做了两件事，且只在 WTQ_TEST_FIXTURE 存在时生效：
//   1) registerSource 顶替 id="zcode" 的会话源：listSessions/getSession/maxSequence/
//      listCompactions/getSegment 全部读 JSON 夹具（每次调用重读文件，测试可动态追加消息）。
//   2) 只拦截 POST */chat/completions：按 prompt 判断"段摘要"还是"总摘要"，回固定假响应。
//      其它 fetch（含 127.0.0.1 的面板 API）原样放行。
//
// 安全约定：
//   · 绝不读取、复制或打印任何真实 API key（llm.mjs 自己拼 Authorization，本文件不碰 headers）。
//   · 只要夹具激活，所有 /chat/completions 请求都被本地假响应截住，不会访问真实远端。
//   · 假响应只包含固定文案与调用计数，不含任何环境信息。
//
// 夹具 JSON 结构：
//   {
//     "sessions":    [{ id, title, cwd, createdAt, updatedAt }],
//     "messages":    { "<sessionId>": [{ id, sequence, time(ms|ISO), role, kind, text,
//                                        tool, toolTitle, toolInput, toolOutput,
//                                        summaryTitle, summaryBody }] },
//     "compactions": { "<sessionId>": [{ boundaryId, time, startedAt, trigger, phase,
//                                        tailSequence, tailMessageId, officialSummary, ... }] }
//   }
//   kind: user_prompt | assistant_response 计入正文；compact_summary 渲染成官方摘要；
//   其余 kind 计入 hiddenRows（与 zcode 源的白名单行为一致）。
//
// 可选夹具字段（GUI 演示 .zcode/tests/gui-demo 用；每次调用重读夹具，改文件即生效、无需重启）：
//   llmMode / llmModes     全局或按会话标题指定 ok|fail|fail-chunk|fail-total
//   llmDelayMs / llmDelaysMs  全局或按会话标题指定每次调用的假延迟
//   llmResponses           { chunk, total } 自定义假摘要正文，支持 {title} / {n} 占位

import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { registerSource } from "../core/sources/index.mjs";

const SUBAGENT_PREFIXES = ["sess_subagent_", "msg_part"];
const TRANSCRIPT_KINDS = new Set(["user_prompt", "assistant_response"]);
const CHAT_RE = /\/chat\/completions(?:[?#]|$)/;

let llmCalls = 0;

/* ---------------- 夹具读取 ---------------- */

function fixtureName() {
  const p = process.env.WTQ_TEST_FIXTURE;
  if (!p) throw new Error("test-preload: 未设置 WTQ_TEST_FIXTURE，不能使用 mock 会话源");
  return p;
}

export function readFixture() {
  return JSON.parse(readFileSync(fixtureName(), "utf8"));
}

function normPath(value) {
  if (!value) return "";
  let s = resolve(String(value));
  s = s.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/* ---------------- mock 会话源 ---------------- */

export function createMockSource() {
  return {
    id: "zcode",
    name: "ZCode (test fixture)",
    default: true,

    listSessions({ cwd, limit = 30, includeSubagents = false } = {}) {
      const fx = readFixture();
      return (fx.sessions ?? [])
        .filter((s) => includeSubagents || !SUBAGENT_PREFIXES.some((p) => String(s.id).startsWith(p)))
        .filter((s) => !cwd || normPath(s.cwd) === normPath(cwd))
        .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
        .slice(0, limit)
        .map((s) => ({
          id: s.id,
          title: s.title ?? "(无标题)",
          cwd: s.cwd,
          createdAt: s.createdAt ?? null,
          updatedAt: s.updatedAt ?? null,
        }));
    },

    getSession(sessionId) {
      const fx = readFixture();
      const s = (fx.sessions ?? []).find((x) => x.id === sessionId);
      if (!s) return null;
      return {
        id: s.id,
        title: s.title ?? "(无标题)",
        slug: s.slug ?? null,
        cwd: s.cwd,
        createdAt: s.createdAt ?? null,
        updatedAt: s.updatedAt ?? null,
      };
    },

    /** 最新消息 sequence；无消息返回 -1（与 zcode 源一致）。 */
    maxSequence(sessionId) {
      const fx = readFixture();
      const seqs = (fx.messages?.[sessionId] ?? []).map((m) => m.sequence);
      return seqs.length ? Math.max(...seqs) : -1;
    },

    /** 归一化压缩边界，按时间升序；缺 tailSequence 又无法从 tailMessageId 解析的丢弃（与 zcode 源一致）。 */
    listCompactions(sessionId) {
      const fx = readFixture();
      const messages = fx.messages?.[sessionId] ?? [];
      return (fx.compactions?.[sessionId] ?? [])
        .map((c) => {
          const row = { ...c };
          if (typeof row.tailSequence !== "number" && row.tailMessageId) {
            const m = messages.find((x) => x.id === row.tailMessageId);
            row.tailSequence = m ? m.sequence : null;
          }
          return row;
        })
        .filter((c) => typeof c.tailSequence === "number")
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    },

    /**
     * sequence 开区间 (fromSeq, toSeq) 内的对话消息。
     * 返回 { messages, stats:{ fromSeq, toSeq, totalRows, userCount, assistantCount, toolCount, hiddenRows } }，
     * fromSeq/toSeq 原样回传（开区间端点）；空区间与 zcode 源一样回 null 端点。
     */
    getSegment(sessionId, fromSeq, toSeq) {
      const fx = readFixture();
      const rows = (fx.messages?.[sessionId] ?? [])
        .filter((m) => m.sequence > fromSeq && m.sequence < toSeq)
        .sort((a, b) => a.sequence - b.sequence);
      if (!rows.length) {
        return {
          messages: [],
          stats: { fromSeq: null, toSeq: null, totalRows: 0, userCount: 0, assistantCount: 0, toolCount: 0, hiddenRows: 0 },
        };
      }

      let hidden = 0;
      let userCount = 0;
      let assistantCount = 0;
      let toolCount = 0;
      const messages = [];
      for (const m of rows) {
        const kind = m.kind ?? null;
        const time = typeof m.time === "string" ? Date.parse(m.time) : m.time ?? null;
        if (kind === "compact_summary") {
          hidden++;
          messages.push({
            id: m.id,
            sequence: m.sequence,
            time,
            role: "user",
            kind,
            special: "official-summary",
            title: m.summaryTitle ?? "Compact summary",
            text: m.summaryBody ?? "",
            parts: [],
          });
          continue;
        }
        if (!TRANSCRIPT_KINDS.has(kind)) {
          hidden++;
          continue;
        }
        const role = m.role ?? (kind === "user_prompt" ? "user" : "assistant");
        const parts = [];
        let pseq = 0;
        if (m.text != null && String(m.text).length) {
          parts.push({ sequence: ++pseq, data: { type: "text", text: String(m.text) } });
        }
        if (m.tool) {
          parts.push({
            sequence: ++pseq,
            data: {
              type: "tool",
              tool: m.tool,
              state: {
                status: m.toolStatus ?? "completed",
                title: m.toolTitle ?? "",
                input: m.toolInput ?? {},
                output: m.toolOutput ?? "",
              },
            },
          });
          toolCount++;
        }
        if (role === "user") userCount++;
        else assistantCount++;
        messages.push({ id: m.id, sequence: m.sequence, time, role, kind, special: null, parts });
      }

      return {
        messages,
        stats: { fromSeq, toSeq, totalRows: rows.length, userCount, assistantCount, toolCount, hiddenRows: hidden },
      };
    },
  };
}

/* ---------------- 假 LLM 响应 ---------------- */

const CHUNK_BODY = (n) =>
  [
    "# 1. 目标与意图",
    `FIXTURE-CHUNK 第 ${n} 次段摘要调用：验证压缩段归档链路。`,
    "",
    "# 2. 已完成事项",
    "- 夹具段摘要已生成",
    "",
    "# 3. 关键决策与理由",
    "- 固定响应，保证测试离线可重复",
    "",
    "# 4. 产出文件与代码位置",
    "- 无",
    "",
    "# 5. 未决问题",
    "- 无",
    "",
    "# 6. 用户偏好与硬约束",
    "- 无",
  ].join("\n");

const TOTAL_BODY = [
  "# 1. 一句话总览",
  "FIXTURE-OVERVIEW 完成交接链路（夹具总摘要）",
  "",
  "# 2. 最终结论与待办",
  "**已完成**",
  "- FIXTURE-CONCLUSION 归档与交接文档已生成",
  "",
  "### 后续建议",
  "- FIXTURE-SUBHEADING 小节内容必须保留在结论要点里",
  "",
  "# 3. 关键决策全表",
  "- FIXTURE-DECISION 沿用现有归档文件格式",
  "",
  "# 4. 用户偏好与硬约束",
  "- FIXTURE-CONSTRAINT 不要修改主实现代码",
  "",
  "# 5. 重要产出清单",
  "- FIXTURE-ARTIFACT TOTAL.md（交接文档）",
  "",
  "# 6. 时间线",
  "- FIXTURE-TIMELINE 2026-09-30 测试运行",
].join("\n");

function logLlmCall(entry) {
  const file = process.env.WTQ_TEST_LLM_LOG;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    // 只记调用元信息：绝不记录 headers / Authorization / 任何密钥。
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    /* 日志失败不影响调用 */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 根据请求 prompt 判断调用类型：总摘要 prompt 含「总对话摘要」，其余算段摘要。 */
function classify(messages) {
  const system = messages.find((m) => m?.role === "system")?.content ?? "";
  return /总对话摘要/.test(String(system)) ? "total" : "chunk";
}

/**
 * 夹具级 LLM 行为（每次调用重读 fixture 文件，所以运行中改文件即可切换，无需重启）：
 *   llmMode       全局模式（env WTQ_TEST_LLM_MODE 作为兜底）
 *   llmModes      { "<会话标题>": "ok"|"fail"|"fail-chunk"|"fail-total" }，按 prompt 里出现的标题匹配
 *   llmDelayMs    全局延迟
 *   llmDelaysMs   { "<会话标题>": 毫秒 }
 *   llmResponses  { chunk: "...", total: "..." }，支持 {title} / {n} 占位
 */
function fixtureLlmSettings(messages) {
  let fx = null;
  try {
    fx = readFixture();
  } catch {
    fx = null;
  }
  const text = JSON.stringify(messages);
  let title = "";
  let mode = null;
  for (const [t, m] of Object.entries(fx?.llmModes ?? {})) {
    if (t && text.includes(t)) {
      title = t;
      mode = String(m);
      break;
    }
  }
  if (mode == null && fx?.llmMode) mode = String(fx.llmMode);
  let delay = Number(process.env.WTQ_TEST_LLM_DELAY_MS || 0);
  if (Number.isFinite(Number(fx?.llmDelaysMs?.[title]))) delay = Number(fx.llmDelaysMs[title]);
  else if (Number.isFinite(Number(fx?.llmDelayMs))) delay = Number(fx.llmDelayMs);
  return { fx, title, mode, delay };
}

function responseBody(kind, n, fx, title) {
  const tpl = kind === "total" ? fx?.llmResponses?.total : fx?.llmResponses?.chunk;
  const raw = typeof tpl === "string" && tpl.trim() ? tpl : kind === "total" ? TOTAL_BODY : CHUNK_BODY(n);
  return String(raw).replaceAll("{title}", title || "演示会话").replaceAll("{n}", String(n));
}

async function fakeCompletion(init) {
  let messages = [];
  try {
    messages = JSON.parse(init?.body ?? "{}").messages ?? [];
  } catch {
    messages = [];
  }
  const { fx, title, mode: fixtureMode, delay } = fixtureLlmSettings(messages);
  const mode = fixtureMode ?? process.env.WTQ_TEST_LLM_MODE ?? "ok";
  const kind = classify(messages);
  const n = ++llmCalls;
  if (delay > 0) await sleep(delay);

  const fail = mode === "fail" || (mode === "fail-chunk" && kind === "chunk") || (mode === "fail-total" && kind === "total");
  // WTQ_TEST_LLM_PROBE：只记录"prompt 里是否出现过某个标记"的布尔值，便于断言内容进入了模型输入；
  // 不记录 prompt 正文，也绝不记录任何 headers。
  const probe = process.env.WTQ_TEST_LLM_PROBE;
  let probeHit;
  if (probe) {
    try {
      probeHit = JSON.stringify(messages).includes(probe);
    } catch {
      probeHit = undefined;
    }
  }
  logLlmCall({ kind, mode, ok: !fail, call: n, title, probeHit });
  if (fail) {
    return new Response(
      JSON.stringify({ error: { message: `fixture: ${kind} call refused (mode=${mode})`, type: "fixture_error" } }),
      { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } },
    );
  }

  const payload = {
    id: "chatcmpl-fixture",
    object: "chat.completion",
    model: "fixture-model",
    choices: [{ index: 0, message: { role: "assistant", content: responseBody(kind, n, fx, title) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/* ---------------- 安装 ---------------- */

export function installFetchFixture() {
  if (globalThis.__WTQ_TEST_FETCH__) return;
  const real = globalThis.fetch;
  globalThis.fetch = async function fixtureFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const method = String(init?.method ?? (typeof input === "object" && input?.method) ?? "GET").toUpperCase();
    if (method === "POST" && CHAT_RE.test(url)) {
      return fakeCompletion(init);
    }
    return real.call(this, input, init);
  };
  globalThis.__WTQ_TEST_FETCH__ = true;
}

/** 注册 mock 源 + 拦截 chat/completions。重复调用安全。 */
export function installFixture() {
  const source = createMockSource();
  registerSource(source);
  installFetchFixture();
  return source;
}

if (process.env.WTQ_TEST_FIXTURE || process.env.WTQ_TEST_PRELOAD) {
  installFixture();
}
