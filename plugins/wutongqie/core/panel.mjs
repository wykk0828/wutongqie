import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { getSource } from "./sources/index.mjs";
import { releaseDb } from "./sources/zcode.mjs";
import { resolveCurrentSession, sameWorkspace } from "./current-session.mjs";
import { buildHandoverText, buildHighlights } from "./handoff.mjs";
import { listProviders } from "./llm.mjs";
import { readJob, listJobs, scopeJob, startWorker } from "./jobs.mjs";
import { requestPrepareSwitch } from "./prepare.mjs";
import { loadConfig, saveConfig, PLUGIN_DATA, PANEL_FILE, PLUGIN_ROOT, DEFAULTS, logEvent, readLog } from "./config.mjs";
import * as store from "./store.mjs";
import { archivedChunkText } from "./chunk-input.mjs";

const VERSION = 3;
const WEB_DIR = join(PLUGIN_ROOT, "web");
const STATIC = new Map([["/app.js", "text/javascript"], ["/lucide.min.js", "text/javascript"], ["/style.css", "text/css"]]);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function panelFile(cwd) {
  if (!cwd) return PANEL_FILE;
  const normalized = resolve(cwd).replace(/\\/g, "/");
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return join(PLUGIN_DATA, `panel-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`);
}

export function readPanelInfo(cwd) {
  try { return JSON.parse(readFileSync(panelFile(cwd), "utf8")); } catch { return null; }
}

export async function probe(port, timeoutMs = 1200) {
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

export async function ensurePanel({ cwd = process.env.ZCODE_PROJECT_DIR || process.cwd(), sessionId } = {}) {
  cwd = resolve(cwd);
  if (sessionId) resolveCurrentSession({ cwd, sessionId });
  const existing = readPanelInfo(cwd) || readPanelInfo();
  if (existing?.version === VERSION && sameWorkspace(existing.cwd, cwd) && (!sessionId || existing.sessionId === sessionId) && await probe(existing.port)) {
    return { ...existing, reused: true };
  }
  mkdirSync(PLUGIN_DATA, { recursive: true });
  const child = spawn(process.execPath, [join(PLUGIN_ROOT, "core", "panel-cli.mjs"), "--serve", "--cwd", cwd, ...(sessionId ? ["--session-id", sessionId] : [])], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  await new Promise((done, fail) => { child.once("spawn", done); child.once("error", fail); });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(120);
    const info = readPanelInfo(cwd);
    if (info?.pid === child.pid && await probe(info.port, 800)) return { ...info, reused: false };
  }
  throw new Error("面板启动超时，请检查插件目录和运行环境。");
}

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("请求内容过长。");
  }
  try { return body.trim() ? JSON.parse(body) : {}; } catch { throw new Error("请求格式错误。"); }
}

function redactProvider(p) {
  return { providerId: p.providerId, name: p.name, apiType: p.apiType, baseUrl: p.baseUrl, usable: p.usable, enabled: p.enabled, models: p.models, hasKey: p.hasKey, keyHint: p.keyHint };
}

function displayJob(job) {
  return job?.mode === "scan" && job.prepareRequested && ["queued", "running", "error", "stale"].includes(job.status)
    ? { ...job, mode: "prepare-switch", phase: "archive" }
    : job;
}

function fileHandover(paths, state) {
  if (!existsSync(paths.total)) return null;
  const markdown = readFileSync(paths.total, "utf8");
  return {
    path: paths.total,
    totalPath: paths.total,
    builtAt: state.totalBuiltAt || statSync(paths.total).mtime.toISOString(),
    handoverText: buildHandoverText(paths.total),
    highlights: buildHighlights(markdown),
    warnings: ["这是旧版生成的交接，建议重新准备以包含最新内容。"],
    liveIncluded: null,
    isDraft: false,
  };
}

function handoverFor(paths, job = null) {
  const state = store.readState(paths);
  if (job?.status === "done" && job.total) return job.total;
  return state.total ?? state.lastFinalTotal ?? job?.handover ?? (state.draft ? null : fileHandover(paths, state));
}

function scopedDisplayJob(cwd, sessionId) {
  return displayJob(scopeJob(readJob(sessionId), sessionId, cwd));
}

function jobSnapshot(cwd, sessionId) {
  if (!sessionId) return { job: null, draft: null, handover: null };
  const job = scopedDisplayJob(cwd, sessionId);
  let session;
  try {
    session = getSource("zcode").getSession(sessionId);
  } catch {
    session = null;
  }
  if (!session) return { job, draft: job?.draft ?? null, handover: job?.handover ?? job?.total ?? null };
  const paths = store.sessionPaths(cwd || session.cwd, session, loadConfig());
  const state = store.readState(paths);
  const draft = state.draft ?? job?.draft ?? null;
  const handover = handoverFor(paths, job);
  return { job, draft, handover };
}

function readChunk(cwd, slug, file) {
  if (!slug || [".", ".."].includes(slug) || !file || slug !== basename(slug) || file !== basename(file) || !file.endsWith(".md")) throw new Error("无效的文档参数。");
  const full = join(store.outputRootFor(cwd), "sessions", slug, file);
  if (!existsSync(full)) throw new Error(`找不到文档：${file}`);
  return archivedChunkText({ dir: join(store.outputRootFor(cwd), "sessions", slug) }, file, loadConfig());
}

function sessionDetail(cwd, slug) {
  if (!slug || [".", ".."].includes(slug) || slug !== basename(slug)) throw new Error("无效的会话目录。");
  const dir = join(store.outputRootFor(cwd), "sessions", slug);
  if (!existsSync(dir)) throw new Error("找不到会话目录。");
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.(md|json)$/.test(entry.name)).map((entry) => {
    const st = statSync(join(dir, entry.name));
    return { name: entry.name, size: st.size, mtime: st.mtime.toISOString() };
  });
  const meta = store.readMeta({ meta: join(dir, "meta.json") });
  return { slug, dir, files, meta, job: meta ? scopedDisplayJob(cwd, meta.sessionId) : null };
}

async function buildState(cwd, boundSessionId, chosenSessionId) {
  const cfg = loadConfig();
  const source = getSource("zcode");
  const root = store.outputRootFor(cwd, cfg);
  const index = store.rebuildIndex(root);
  const out = { cwd, boundCwd: cwd, pid: process.pid, root, config: cfg, defaults: DEFAULTS, providers: listProviders().map(redactProvider), log: readLog(60), jobs: listJobs().filter((job) => sameWorkspace(job.cwd, cwd)).map((job) => scopeJob(job, job.sessionId, cwd)), sessions: [], unarchived: [], choices: [], current: null };
  let live = [];
  try { live = source.listSessions({ cwd, limit: 50 }); } catch (err) { out.liveError = String(err?.message ?? err); }
  const byId = new Map(live.map((session) => [session.id, session]));
  out.sessions = index.sessions.filter((session) => sameWorkspace(session.cwd, cwd) || byId.has(session.sessionId)).map((session) => {
    const job = scopedDisplayJob(cwd, session.sessionId);
    const state = store.readState(store.sessionPaths(cwd, session, cfg));
    return {
      ...session,
      updatedAt: byId.get(session.sessionId)?.updatedAt ?? session.updatedAt,
      inDb: byId.has(session.sessionId),
      job,
      draft: state.draft ?? job?.draft ?? null,
      running: ["queued", "running"].includes(job?.status),
    };
  });
  out.unarchived = live.filter((session) => !index.sessions.some((item) => item.sessionId === session.id)).map((session) => {
    const job = scopedDisplayJob(cwd, session.id);
    const paths = store.sessionPaths(cwd, session, cfg);
    const state = store.readState(paths);
    return {
      ...session,
      sessionId: session.id,
      job,
      draft: state.draft ?? job?.draft ?? null,
      running: ["queued", "running"].includes(job?.status),
      pendingCompactions: source.listCompactions(session.id).length,
    };
  });
  out.choices = live.map((session) => ({ sessionId: session.id, title: session.title, updatedAt: session.updatedAt }));
  try {
    const resolved = resolveCurrentSession({ cwd, sessionId: chosenSessionId || boundSessionId });
    const { session, resolvedBy } = resolved;
    const paths = store.sessionPaths(cwd, session, cfg);
    const state = store.readState(paths);
    const job = scopedDisplayJob(cwd, session.id);
    const draft = state.draft ?? job?.draft ?? null;
    const handover = handoverFor(paths, job);
    const maxSeq = source.maxSequence(session.id);
    const archived = index.sessions.find((item) => item.sessionId === session.id);
    out.current = {
      sessionId: session.id, title: session.title, updatedAt: session.updatedAt, resolvedBy,
      slug: basename(paths.dir), dir: paths.dir, chunkCount: archived?.chunkCount ?? 0,
      job, draft, handover, stale: Boolean(handover && (state.totalThroughSequence == null || maxSeq > state.totalThroughSequence)),
    };
  } catch (err) { out.currentError = String(err?.message ?? err); }
  return out;
}

function openFolder(cwd, path) {
  if (!path) throw new Error("缺少目录路径。");
  const root = store.outputRootFor(cwd);
  const diff = relative(root, resolve(path));
  if (diff.startsWith("..") || isAbsolute(diff)) throw new Error("只能打开当前归档目录。");
  if (!existsSync(path)) throw new Error("归档目录尚未创建。");
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [path], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (err) => logEvent("open-folder-error", { error: String(err.message) }));
  child.unref();
  return { ok: true, path };
}

export function runServer(startCwd, boundSessionId) {
  const cwd = resolve(startCwd || process.cwd());
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  let lastHit = Date.now();
  mkdirSync(PLUGIN_DATA, { recursive: true });
  const server = createServer(async (req, res) => {
    lastHit = Date.now();
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const host = req.headers.host || "";
      if (!/^127\.0\.0\.1:\d+$/.test(host)) return json(res, 403, { error: "无效的本地地址。" });
      const publicGet = req.method === "GET" && (url.pathname === "/" || url.pathname === "/api/ping" || STATIC.has(url.pathname));
      if (!publicGet && req.headers["x-wtq-token"] !== token) return json(res, 403, { error: "面板令牌已失效，请重新打开面板。" });
      if (req.method === "GET") {
        if (url.pathname === "/api/ping") return json(res, 200, { ok: true, pid: process.pid, startedAt, cwd, sessionId: boundSessionId ?? null, version: VERSION });
        if (url.pathname === "/") {
          const safeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
          const html = readFileSync(join(WEB_DIR, "index.html"), "utf8")
            .replaceAll("__WTQ_TOKEN__", token).replaceAll("__WTQ_CWD__", safeJson(cwd)).replaceAll("__WTQ_SESSION_ID__", safeJson(boundSessionId || ""));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          return res.end(html);
        }
        if (STATIC.has(url.pathname)) {
          res.writeHead(200, { "Content-Type": `${STATIC.get(url.pathname)}; charset=utf-8`, "Cache-Control": "no-store" });
          return res.end(readFileSync(join(WEB_DIR, basename(url.pathname))));
        }
        if (url.pathname === "/api/state") return json(res, 200, await buildState(cwd, boundSessionId, url.searchParams.get("sessionId")));
        if (url.pathname === "/api/job") {
          const requested = url.searchParams.get("sessionId") || boundSessionId;
          const resolved = resolveCurrentSession({ cwd, sessionId: requested });
          const snapshot = jobSnapshot(cwd, resolved.session.id);
          const state = store.readState(store.sessionPaths(cwd, resolved.session, loadConfig()));
          const maxSeq = getSource("zcode").maxSequence(resolved.session.id);
          return json(res, 200, {
            ok: true,
            sessionId: resolved.session.id,
            resolvedBy: resolved.resolvedBy,
            ...snapshot,
            stale: Boolean(snapshot.handover && (state.totalThroughSequence == null || maxSeq > state.totalThroughSequence)),
          });
        }
        if (url.pathname === "/api/session") return json(res, 200, sessionDetail(cwd, url.searchParams.get("slug")));
        if (url.pathname === "/api/chunk") return json(res, 200, { file: url.searchParams.get("file"), markdown: readChunk(cwd, url.searchParams.get("slug"), url.searchParams.get("file")) });
        if (url.pathname === "/api/providers") return json(res, 200, { providers: listProviders().map(redactProvider) });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (["/api/prepare-switch", "/api/total", "/api/archive"].includes(url.pathname)) {
          if (body.cwd && !sameWorkspace(body.cwd, cwd)) throw new Error("面板属于另一个工作区，请从当前工作区重新打开。");
          const resolved = resolveCurrentSession({ cwd, sessionId: body.sessionId || boundSessionId });
          if (url.pathname === "/api/archive") {
            const result = await startWorker(resolved.session.id, cwd, "scan", resolved.resolvedBy);
            return json(res, 202, { ok: true, sessionId: resolved.session.id, ...result, job: displayJob(result.job) });
          }
          const result = await requestPrepareSwitch({ ...body, cwd, sessionId: resolved.session.id });
          return json(res, result.status === "cached" ? 200 : 202, {
            ok: true,
            sessionId: resolved.session.id,
            ...result,
            job: result.job ? displayJob(result.job) : null,
          });
        }
        if (url.pathname === "/api/open-folder") return json(res, 200, openFolder(cwd, body.path));
        if (url.pathname === "/api/config") return json(res, 200, { config: saveConfig(body.patch ?? {}) });
        if (url.pathname === "/api/shutdown") {
          json(res, 200, { ok: true });
          setTimeout(() => server.close(() => process.exit(0)), 50);
          return;
        }
      }
      return json(res, 404, { error: "找不到接口。" });
    } catch (err) {
      logEvent("panel-error", { error: String(err?.message ?? err).slice(0, 500) });
      json(res, 500, { error: String(err?.message ?? err) });
    }
  });
  server.listen(0, "127.0.0.1", () => {
    const info = { port: server.address().port, pid: process.pid, startedAt, cwd, sessionId: boundSessionId ?? null, version: VERSION };
    writeFileSync(panelFile(cwd), JSON.stringify(info, null, 2) + "\n", "utf8");
    writeFileSync(PANEL_FILE, JSON.stringify(info, null, 2) + "\n", "utf8");
    logEvent("panel-start", info);
  });
  const idle = setInterval(() => {
    if (Date.now() - lastHit > 2 * 60 * 60 * 1000) server.close(() => process.exit(0));
  }, 5 * 60 * 1000);
  idle.unref();
  process.on("exit", () => {
    releaseDb();
    for (const file of [panelFile(cwd), PANEL_FILE]) {
      try {
        if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) writeFileSync(file, JSON.stringify({ stoppedAt: new Date().toISOString() }) + "\n");
      } catch { /* 不修改其他进程的面板状态。 */ }
    }
  });
  return server;
}
