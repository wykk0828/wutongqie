import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, closeSync, unlinkSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PLUGIN_DATA, PLUGIN_ROOT, loadConfig } from "./config.mjs";
import { getSource } from "./sources/index.mjs";
import * as store from "./store.mjs";

const JOBS_DIR = join(PLUGIN_DATA, "jobs");
const RUNNING_TTL_MS = 2 * 60 * 60 * 1000;
const active = (job) => job && ["queued", "running"].includes(job.status);
const jobFile = (id) => join(JOBS_DIR, `${String(id).replace(/[^\w.-]/g, "_")}.json`);
const lockFile = (id) => jobFile(id) + ".lock";

function canonicalPath(value) {
  if (!value) return null;
  try {
    const normalized = resolve(String(value)).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    return null;
  }
}

function artifactBelongsTo(paths, artifact) {
  const actual = canonicalPath(artifact?.path ?? artifact?.totalPath);
  return Boolean(actual && actual === canonicalPath(paths?.total));
}

/**
 * 任务记录按 sessionId 保存，但同一个会话可能被不同工作区/测试输出根复用。
 * 只把当前归档根目录下的草稿和交接结果暴露给调用方，避免串读另一根目录的 TOTAL.md。
 */
export function scopeJob(job, sessionId, cwd) {
  if (!job) return job;
  let paths = null;
  try {
    const source = getSource("zcode");
    const session = source.getSession(sessionId);
    if (session) paths = store.sessionPaths(cwd || session.cwd, session, loadConfig());
  } catch {
    paths = null;
  }
  const scoped = { ...job };
  for (const field of ["draft", "handover", "total"]) {
    if (scoped[field] && (!paths || !artifactBelongsTo(paths, scoped[field]))) scoped[field] = null;
  }
  return scoped;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function alive(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

function atomicWrite(file, data) {
  mkdirSync(JOBS_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function storedHandover(sessionId, cwd) {
  try {
    const source = getSource("zcode");
    const session = source.getSession(sessionId);
    if (!session) return { draft: null, handover: null };
    const paths = store.sessionPaths(cwd || session.cwd, session, loadConfig());
    const state = store.readState(paths);
    return {
      draft: state.draft ?? null,
      handover: state.total ?? state.lastFinalTotal ?? null,
    };
  } catch {
    return { draft: null, handover: null };
  }
}

export function attachHandover(job, sessionId, cwd) {
  const snapshot = storedHandover(sessionId, cwd);
  return { ...scopeJob(job, sessionId, cwd), ...snapshot };
}

export function readJob(sessionId) {
  const job = readJson(jobFile(sessionId));
  if (!job) return null;
  if (active(job)) {
    const age = Date.now() - Date.parse(job.updatedAt || job.startedAt);
    if (!alive(job.pid) || !Number.isFinite(age) || age > RUNNING_TTL_MS) {
      return { ...job, status: "stale", error: "后台任务已中断，可以重新准备交接。", finishedAt: new Date().toISOString() };
    }
  }
  return job;
}

export function writeJob(sessionId, patch) {
  const prev = readJob(sessionId) ?? {};
  const next = { ...prev, ...patch, sessionId, updatedAt: new Date().toISOString() };
  atomicWrite(jobFile(sessionId), next);
  return next;
}

export function isRunning(sessionId) {
  return Boolean(active(readJob(sessionId)));
}

// 独占锁跨进程生效；状态文件只用于进度展示，不能代替互斥。
export function claimJob(sessionId, { mode, cwd, resolvedBy } = {}) {
  mkdirSync(JOBS_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(lockFile(sessionId), "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const lock = readJson(lockFile(sessionId));
      const job = readJob(sessionId);
      if (!lock) {
        try { if (Date.now() - statSync(lockFile(sessionId)).mtimeMs < RUNNING_TTL_MS) return null; } catch { return null; }
      }
      if (active(job) || (lock && lock.jobId !== job?.jobId && alive(lock.pid) && Date.now() - Date.parse(lock.startedAt) < RUNNING_TTL_MS)) return null;
      try { unlinkSync(lockFile(sessionId)); } catch { return null; }
      continue;
    }
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    try { writeFileSync(fd, JSON.stringify({ jobId, pid: process.pid, startedAt })); } finally { closeSync(fd); }
    return attachHandover(writeJob(sessionId, {
      jobId, status: "queued", mode, cwd, resolvedBy, phase: "queued", pid: process.pid,
      startedAt, finishedAt: null, error: null, total: null, warnings: [],
      reportedAt: null, progress: null, count: null, newCount: 0, durationMs: null, prepareRequested: false,
    }), sessionId, cwd);
  }
  return null;
}

export function updateJob(sessionId, jobId, patch) {
  const lock = readJson(lockFile(sessionId));
  if (lock?.jobId !== jobId) return null;
  return writeJob(sessionId, patch);
}

export function finishJob(sessionId, jobId, patch) {
  const next = updateJob(sessionId, jobId, { ...patch, finishedAt: new Date().toISOString() });
  if (readJson(lockFile(sessionId))?.jobId === jobId) {
    try { unlinkSync(lockFile(sessionId)); } catch { /* 下次启动会清理失效锁。 */ }
  }
  return next;
}

export async function startWorker(sessionId, cwd, mode = "prepare-switch", resolvedBy, retry = 0) {
  const job = claimJob(sessionId, { mode, cwd, resolvedBy });
  if (!job) {
    const current = readJob(sessionId);
    if (mode === "prepare-switch" && current?.mode === "scan") {
      const queued = updateJob(sessionId, current.jobId, { prepareRequested: true, resolvedBy });
      if (!queued) {
        if (retry >= 2) throw new Error("后台任务状态正在变化，请稍后重试。");
        return startWorker(sessionId, cwd, mode, resolvedBy, retry + 1);
      }
      return { existing: true, job: attachHandover(queued, sessionId, cwd) };
    }
    return { existing: true, job: attachHandover(current, sessionId, cwd) };
  }
  try {
    const child = spawn(process.execPath, [join(PLUGIN_ROOT, "core", "worker.mjs"), mode, sessionId, cwd, job.jobId], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (readJob(sessionId)?.status === "queued") updateJob(sessionId, job.jobId, { pid: child.pid });
    child.unref();
    return { existing: false, job: attachHandover(readJob(sessionId), sessionId, cwd) };
  } catch (err) {
    const snapshot = storedHandover(sessionId, cwd);
    finishJob(sessionId, job.jobId, {
      status: "error",
      phase: "error",
      error: String(err?.message ?? err),
      draft: snapshot.draft,
      handover: snapshot.handover,
      durationMs: 0,
    });
    throw err;
  }
}

export function clearJob(sessionId) {
  if (!isRunning(sessionId)) writeJob(sessionId, { status: "idle" });
}

export function listJobs() {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR).filter((name) => name.endsWith(".json"))
    .map((name) => readJob(name.slice(0, -5))).filter(Boolean)
    .sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
}

export { JOBS_DIR };
