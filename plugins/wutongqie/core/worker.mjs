import { scanSession, buildTotal } from "./archive.mjs";
import { releaseDb } from "./sources/zcode.mjs";
import {
  claimJob,
  readJob,
  updateJob,
  finishJob,
  startWorker,
  storedHandover,
} from "./jobs.mjs";
import { loadConfig, logEvent } from "./config.mjs";

const [, , mode = "scan", sessionId, cwd, assignedJobId] = process.argv;

if (!sessionId || !["scan", "total", "prepare-switch"].includes(mode)) {
  process.stderr.write("用法: node core/worker.mjs <scan|total|prepare-switch> <sessionId> <cwd>\n");
  process.exitCode = 2;
} else {
  const job = assignedJobId
    ? readJob(sessionId)
    : claimJob(sessionId, { mode, cwd });

  if (
    job?.jobId
    && ["queued", "running"].includes(job.status)
    && (!assignedJobId || job.jobId === assignedJobId)
  ) {
    const started = Date.now();
    const jobId = job.jobId;
    const initial = storedHandover(sessionId, cwd);

    updateJob(sessionId, jobId, {
      status: "running",
      phase: "archive",
      pid: process.pid,
      draft: initial.draft,
      handover: initial.handover,
    });

    const heartbeat = setInterval(() => updateJob(sessionId, jobId, {}), 10_000);
    heartbeat.unref();

    try {
      const cfg = loadConfig();
      const onProgress = (patch) => updateJob(sessionId, jobId, patch);
      let result;

      if (mode === "total" || mode === "prepare-switch") {
        const total = await buildTotal({
          sessionOrId: sessionId,
          cwd,
          cfg: { ...cfg, skipLiveForTotal: false },
          onProgress,
        });
        result = {
          total: { ...total, resolvedBy: job.resolvedBy },
          warnings: total.warnings,
          newCount: 0,
        };
      } else {
        const scanned = await scanSession(sessionId, {
          cwd,
          cfg,
          summarize: true,
          onProgress,
        });
        result = {
          newCount: scanned.newCount,
          chunks: scanned.chunks,
          live: scanned.live,
          errors: scanned.errors,
          paths: {
            root: scanned.paths.root,
            dir: scanned.paths.dir,
          },
          fatal: scanned.errors.length > 0 && scanned.newCount === 0,
        };
      }

      const durationMs = Date.now() - started;
      const finalSnapshot = storedHandover(sessionId, cwd);
      const completed = finishJob(sessionId, jobId, {
        ...result,
        status: "done",
        phase: "done",
        durationMs,
        draft: result.total ? null : finalSnapshot.draft,
        handover: result.total
          ? result.total
          : finalSnapshot.handover,
      });

      logEvent("job-done", {
        sessionId,
        mode,
        durationMs,
        newCount: result.newCount,
      });

      if (mode === "scan" && completed?.prepareRequested) {
        await startWorker(
          sessionId,
          cwd,
          "prepare-switch",
          completed.resolvedBy,
        );
      }
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 1500);
      const failedSnapshot = storedHandover(sessionId, cwd);
      finishJob(sessionId, jobId, {
        status: "error",
        phase: "error",
        durationMs: Date.now() - started,
        error: message,
        draft: failedSnapshot.draft,
        handover: failedSnapshot.handover,
      });
      logEvent("job-error", {
        sessionId,
        mode,
        error: message.slice(0, 500),
      });
    } finally {
      clearInterval(heartbeat);
      releaseDb();
    }
  }
}
