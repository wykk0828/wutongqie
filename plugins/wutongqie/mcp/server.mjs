// MCP stdio server。手写 JSON-RPC，不引 SDK，保持零依赖。
//
// 提供工具：
//   open_panel            打开/复用本地网页面板，返回 URL
//   list_sessions         列出工作区会话 + 归档进度
//   list_chunks           列出某会话已有的归档
//   read_chunk            读某一段的归档全文
//   archive_now           立刻归档新增的压缩段
//   build_total_summary   立刻生成总对话摘要
//   archive_status        查看后台任务与最近日志
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSource } from "../core/sources/index.mjs";
import { releaseDb } from "../core/sources/zcode.mjs";
import { scanSession, extractChunkSummary } from "../core/archive.mjs";
import { requestPrepareSwitch } from "../core/prepare.mjs";
import { resolveCurrentSession } from "../core/current-session.mjs";
import { ensurePanel } from "../core/panel.mjs";
import { readJob, listJobs, isRunning, claimJob, updateJob, finishJob } from "../core/jobs.mjs";
import { listProviders } from "../core/llm.mjs";
import { loadConfig, readLog, logEvent } from "../core/config.mjs";
import * as store from "../core/store.mjs";
import { archivedChunkText } from "../core/chunk-input.mjs";

const SERVER_INFO = { name: "wutongqie", version: "1.3.1" };

const TOOLS = [
  {
    name: "prepare_switch",
    description: "准备切换会话：自动选择当前工作区的主会话，立即返回可复制的交接草稿或已缓存最终版，后台继续完善并覆盖同一个 TOTAL.md。用户说‘我要换会话’‘准备开新对话’‘生成交接文档’‘保存这次对话’时优先使用；无需先查会话编号。用户不需要等待。",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "工作区路径，默认当前工作区" }, sessionId: { type: "string", description: "可选，指定另一主会话" } },
      additionalProperties: false,
    },
  },
  {
    name: "open_panel",
    description: "打开「无痛切」本地网页面板（127.0.0.1），查看交接进度、历史记录和高级设置。只有用户要打开面板时使用；直接准备交接请用 prepare_switch。",
    inputSchema: { type: "object", properties: { cwd: { type: "string" }, sessionId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "list_sessions",
    description: "列出当前工作区的 ZCode 会话，标注各自有多少压缩边界已归档、还差多少。",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "工作区路径，默认用当前会话的" } },
      additionalProperties: false,
    },
  },
  {
    name: "list_chunks",
    description: "列出某个会话已归档的段摘要文件。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 id（sess_...）" },
        cwd: { type: "string" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_chunk",
    description: "读取某个会话的某一段归档。file 传 TOTAL.md 取总摘要，传 LIVE.md 取尚未被压缩的活跃段。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        file: { type: "string", description: "文件名，如 01-20260930-1342.md / TOTAL.md / LIVE.md" },
        summaryOnly: { type: "boolean", description: "只要摘要正文，去掉 frontmatter 和折叠的官方摘要" },
        cwd: { type: "string" },
      },
      required: ["sessionId", "file"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_now",
    description: "立刻扫描并归档该会话新增的压缩段（会调模型写摘要，较慢，通常几十秒到几分钟）。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        summarize: { type: "boolean", description: "false = 只落原文不调模型" },
        cwd: { type: "string" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "build_total_summary",
    description:
      "兼容旧调用的交接生成工具，与 prepare_switch 相同。新调用优先使用 prepare_switch。", 
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, cwd: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "archive_status",
    description: "查看无痛切的后台任务状态、最近日志，以及可用的模型供应商。排障用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function text(s) {
  return { content: [{ type: "text", text: String(s) }] };
}

function resolveSession(sessionId) {
  const source = getSource("zcode");
  const session = source.getSession(sessionId);
  if (!session) throw new Error(`找不到会话 ${sessionId}`);
  return session;
}

async function prepareResult(args) {
  const result = await requestPrepareSwitch(args);
  const handover = result.handover ?? result.draft ?? result;
  const warnings = Array.isArray(handover?.warnings) ? handover.warnings : [];
  const highlights = handover?.highlights ?? {};
  const statusText = result.status === "cached"
    ? "已复用最新交接，不需要再次调用模型。"
    : result.status === "running"
      ? "后台任务正在运行，下面的内容可以立即复制。"
      : "已立即生成可复制草稿，后台继续完善最终交接。";
  const path = handover?.totalPath ?? handover?.path ?? result.path ?? "";
  const copyText = handover?.handoverText ?? result.handoverText ?? "";
  return {
    structuredContent: {
      ...result,
      status: result.status ?? (result.reused ? "cached" : "queued"),
      jobId: result.jobId ?? result.job?.jobId ?? null,
      path,
      warnings,
      draft: result.draft ?? (handover?.isDraft ? handover : null),
      handover: result.handover ?? (!handover?.isDraft ? handover : null),
    },
    content: [{ type: "text", text: [
      result.status === "cached" ? "交接已复用" : "交接请求已返回",
      path ? `文档路径：${path}` : "",
      handover?.sessionTitle ? `会话：${handover.sessionTitle}` : "",
      result.resolvedBy === "latest-updated" ? "已自动选择最近使用的会话。" : "",
      statusText,
      result.background ? "后台完成后会覆盖同一个 TOTAL.md；不需要等待。" : "",
      result.jobId ? `后台任务：${result.jobId}` : "",
      handover?.liveIncluded ? "已包含当前未压缩内容。" : "当前没有未压缩内容。",
      "", "一句话总览", highlights.overview || "请查看交接文档。",
      "", "最终结论与待办", highlights.conclusions || "请查看交接文档。",
      "", "用户偏好与硬约束", highlights.constraints || "请查看交接文档。",
      ...warnings.map((warning) => `注意：${warning}`),
      copyText ? "" : "",
      copyText ? "复制到新会话：" : "请稍后从面板或 TOTAL.md 获取交接内容。",
      copyText,
    ].filter((line) => line !== undefined && line !== "").join("\n") }],
  };
}

const handlers = {
  prepare_switch: prepareResult,
  async open_panel(args) {
    const cwd = args.cwd || process.env.ZCODE_PROJECT_DIR || process.cwd();
    let sessionId = args.sessionId;
    if (!sessionId) {
      try {
        const resolved = resolveCurrentSession({ cwd });
        if (resolved.resolvedBy === "environment") sessionId = resolved.session.id;
      } catch { /* 空工作区仍可打开面板。 */ }
    }
    const info = await ensurePanel({ cwd, sessionId });
    const url = `http://127.0.0.1:${info.port}/`;
    return text([`面板已${info.reused ? "复用" : "启动"}：${url}`, `工作区：${cwd}`, "准备换会话时点击‘准备切换会话’，完成后复制新会话提示。"].join("\n"));
  },

  async list_sessions(args) {
    const source = getSource("zcode");
    const cwd = args.cwd || process.env.ZCODE_PROJECT_DIR || process.cwd();
    const cfg = loadConfig();
    const root = store.outputRootFor(cwd, cfg);
    const index = store.rebuildIndex(root);
    const byId = new Map(index.sessions.map((s) => [s.sessionId, s]));

    const rows = source.listSessions({ cwd, limit: 25 }).map((s) => {
      const comps = source.listCompactions(s.id);
      const arch = byId.get(s.id);
      const job = readJob(s.id);
      return {
        sessionId: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        compactions: comps.length,
        archivedChunks: arch?.chunkCount ?? 0,
        hasTotal: Boolean(arch?.total),
        pending: comps.length - (arch?.processedCount ?? 0),
        running: isRunning(s.id),
        lastJob: job ? { status: job.status, mode: job.mode, error: job.error ? String(job.error).split("\n")[0] : null } : null,
      };
    });
    return text(
      [`归档根目录：${root}`, "", "sessionId | 压缩次数 | 已归档 | 待归档 | 总摘要 | 最近更新", ...rows.map((r) =>
        `${r.sessionId} | ${r.compactions} | ${r.archivedChunks} | ${r.pending} | ${r.hasTotal ? "有" : "无"} | ${r.updatedAt?.slice(0, 19)} | ${r.title}` +
        `${r.running ? "  [后台任务运行中]" : ""}${r.lastJob?.status === "error" ? `  [上次失败: ${r.lastJob.error}]` : ""}`,
      )].join("\n"),
    );
  },

  async list_chunks(args) {
    const session = resolveSession(args.sessionId);
    const paths = store.sessionPaths(args.cwd || session.cwd, session, loadConfig());
    const items = store.listChunks(paths);
    if (!items.length) return text(`会话「${session.title}」还没有任何归档段。`);
    return text(
      [
        `会话：${session.title}`,
        `目录：${paths.dir}`,
        "",
        ...items.map((i) => {
          let size = 0;
          try { size = statSync(i.path).size; } catch { /* 忽略 */ }
          return `${i.file}  ${size} 字符${i.live ? "  (尚未被压缩的活跃段)" : ""}`;
        }),
      ].join("\n"),
    );
  },

  async read_chunk(args) {
    const session = resolveSession(args.sessionId);
    const paths = store.sessionPaths(args.cwd || session.cwd, session, loadConfig());
    const full = join(paths.dir, store.safeName(args.file, ""));
    if (!existsSync(full)) throw new Error(`找不到 ${args.file}（可用文件：${store.listChunks(paths).map((i) => i.file).join(", ") || "无"}）`);
    const md = archivedChunkText(paths, args.file, loadConfig());
    return text(args.summaryOnly ? extractChunkSummary(md) : md);
  },

  async archive_now(args) {
    const { session, cwd } = resolveCurrentSession(args);
    const job = claimJob(session.id, { cwd, mode: "scan" });
    if (!job) return text("该会话已有后台任务正在进行，请稍后再试。");
    const started = Date.now();
    updateJob(session.id, job.jobId, { status: "running", phase: "archive" });
    const heartbeat = setInterval(() => updateJob(session.id, job.jobId, {}), 10_000);
    heartbeat.unref();
    try {
      const scanned = await scanSession(session, { cwd, cfg: loadConfig(), summarize: args.summarize !== false,
        onProgress: (patch) => updateJob(session.id, job.jobId, patch) });
      finishJob(session.id, job.jobId, { status: "done", phase: "done", newCount: scanned.newCount, errors: scanned.errors, durationMs: Date.now() - started });
      return text([`已补充归档 ${scanned.newCount} 段，目录：${scanned.paths.dir}`, ...scanned.errors.map((error) => `注意：${error.error}`)].join("\n"));
    } catch (err) {
      finishJob(session.id, job.jobId, { status: "error", error: String(err?.message ?? err), durationMs: Date.now() - started });
      throw err;
    } finally { clearInterval(heartbeat); }
  },

  build_total_summary: prepareResult,

  async archive_status() {
    const jobs = listJobs().slice(-15);
    const provs = listProviders();
    return text(
      [
        `插件数据目录：${process.env.ZCODE_PLUGIN_DATA || "(默认)"}`,
        "",
        "== 后台任务 ==",
        ...(jobs.length ? jobs.map((j) => `  ${j.sessionId}  ${j.status}  ${j.mode ?? ""}  ${j.newCount ? `+${j.newCount}段` : ""} ${j.error ? String(j.error).split("\n")[0].slice(0, 120) : ""}`) : ["  无"]),
        "",
        "== 模型供应商 ==",
        ...provs.map((p) => `  ${p.usable ? "✔" : "✖"} ${p.name}  ${p.apiType ?? "-"}  ${p.models.join(",") || "-"}  key=${p.keyHint || "无"}`),
        "",
        "== 最近日志 ==",
        ...readLog(15).map((l) => `  ${l.at?.slice(11, 19)} ${l.event} ${JSON.stringify(l).slice(0, 180)}`),
      ].join("\n"),
    );
  },
};

// ---------- JSON-RPC ----------

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;

  const reply = (result) => {
    if (id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  };
  const fail = (code, message) => {
    if (id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  };

  try {
    switch (method) {
      case "initialize":
        logEvent("mcp-init", {});
        return reply({
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = params?.name;
        const handler = handlers[name];
        if (!handler) {
          // 未知工具按协议返回错误，让模型自己纠正
          return reply({ content: [{ type: "text", text: `没有这个工具: ${name}。可用: ${TOOLS.map((t) => t.name).join(", ")}` }], isError: true });
        }
        const out = await handler(params?.arguments ?? {});
        return reply(out);
      }
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        if (id !== undefined) fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = String(err?.message ?? err);
    logEvent("mcp-error", { method, error: message.slice(0, 400) });
    if (id !== undefined) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `执行失败: ${message}` }], isError: true } }) + "\n",
      );
    }
  }
}

process.on("SIGINT", () => {
  releaseDb();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseDb();
  process.exit(0);
});
