import { buildTotal, getReusableTotal } from "./archive.mjs";
import { createDraft } from "./draft.mjs";
import { resolveCurrentSession } from "./current-session.mjs";
import {
  claimJob,
  readJob,
  updateJob,
  finishJob,
  startWorker,
  storedHandover,
} from "./jobs.mjs";
import { loadConfig } from "./config.mjs";

function prepareConfig(options) {
  return { ...(options.cfg ?? loadConfig()), skipLiveForTotal: false };
}

/**
 * 立即领取/复用后台交接任务，并返回无需等待模型的可复制草稿。
 * 面板和 MCP 共用这条路径；真正的最终 TOTAL 由 worker 完成。
 */
export async function requestPrepareSwitch(options = {}) {
  const resolved = resolveCurrentSession(options);
  const { session, cwd, resolvedBy } = resolved;
  const cfg = prepareConfig(options);
  const reusable = getReusableTotal({ sessionOrId: session, cwd, cfg });
  if (reusable.total) {
    return {
      ...reusable.total,
      status: "cached",
      reused: true,
      background: false,
      resolvedBy,
      draft: null,
      handover: reusable.total,
      job: null,
    };
  }

  const current = readJob(session.id);
  const currentActive = current && ["queued", "running"].includes(current.status);
  const stored = storedHandover(session.id, cwd);
  let draftResult;

  if (currentActive && (stored.draft || stored.handover)) {
    draftResult = {
      draft: stored.draft ?? stored.handover,
      state: reusable.state,
      reusedDraft: true,
    };
  } else {
    try {
      draftResult = createDraft({ sessionOrId: session, cwd, cfg });
    } catch (err) {
      const previous = reusable.state.total ?? reusable.state.lastFinalTotal ?? null;
      if (!previous) throw err;
      draftResult = {
        draft: { ...previous, isDraft: false, reused: true },
        state: reusable.state,
      };
    }
  }

  const started = await startWorker(session.id, cwd, "prepare-switch", resolvedBy);
  const job = started.job;
  const status = job?.status === "running" ? "running" : "queued";
  const candidate = draftResult.draft ?? job?.draft ?? job?.handover ?? null;
  const draft = candidate?.isDraft ? candidate : null;
  const handover = candidate?.isDraft
    ? (job?.total && !job.total.isDraft ? job.total : stored.handover ?? null)
    : candidate;
  return {
    ...(candidate ?? {}),
    draft,
    handover,
    status,
    background: true,
    reused: Boolean(started.existing || draftResult.reusedDraft),
    existing: Boolean(started.existing),
    resolvedBy,
    job,
    jobId: job?.jobId ?? null,
    message: started.existing || draftResult.reusedDraft
      ? "已并入正在运行的后台任务，可先复制当前交接。"
      : "已立即生成草稿，后台继续完善最终交接。",
  };
}

/**
 * 保留脚本和旧调用方的同步兼容接口。MCP/面板使用 requestPrepareSwitch，
 * 直接调用 prepareSwitch 仍会等待最终 TOTAL，避免破坏已有自动化脚本。
 */
export async function prepareSwitch(options = {}) {
  if (options.wait === false) return requestPrepareSwitch(options);
  const resolved = resolveCurrentSession(options);
  const { session, cwd, resolvedBy } = resolved;
  const cfg = prepareConfig(options);
  const reusable = getReusableTotal({ sessionOrId: session, cwd, cfg });
  if (reusable.total) return { ...reusable.total, resolvedBy, reused: true, status: "cached" };

  const job = claimJob(session.id, { cwd, mode: "prepare-switch", resolvedBy });
  if (!job) throw new Error("当前会话有后台任务正在进行，请稍后重试或在面板查看进度。");
  const started = Date.now();
  updateJob(session.id, job.jobId, { status: "running", phase: "archive" });
  const heartbeat = setInterval(() => updateJob(session.id, job.jobId, {}), 10_000);
  heartbeat.unref();
  try {
    const total = await buildTotal({
      sessionOrId: session, cwd,
      cfg,
      onProgress: (patch) => updateJob(session.id, job.jobId, patch),
    });
    const handover = { ...total, resolvedBy };
    finishJob(session.id, job.jobId, { status: "done", phase: "done", total: handover, warnings: total.warnings, durationMs: Date.now() - started });
    return handover;
  } catch (err) {
    finishJob(session.id, job.jobId, { status: "error", phase: "error", error: String(err?.message ?? err), durationMs: Date.now() - started });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}
