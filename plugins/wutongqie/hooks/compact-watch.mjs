// ZCode 钩子入口：Stop / UserPromptSubmit
//
// ZCode 没有 PreCompact 钩子，所以这里改成「每轮结束时快速看一眼有没有新压缩」。
// 关键约束是**必须快**：检测只读一下 SQLite，发现有新压缩就 spawn 一个 detached
// 进程去干重活（调模型写摘要），本进程立刻退出，用户完全感觉不到。
//
// 任何异常都吞掉并以 exit 0 结束——归档失败绝不能影响用户的对话。
import { getSource } from "../core/sources/index.mjs";
import { releaseDb } from "../core/sources/zcode.mjs";
import { readJob, isRunning, writeJob, startWorker } from "../core/jobs.mjs";
import { loadConfig, logEvent } from "../core/config.mjs";
import { isMainSession } from "../core/current-session.mjs";
import * as store from "../core/store.mjs";

function readStdin() {
  return new Promise((res) => {
    let buf = "";
    if (process.stdin.isTTY) return res({});
    // 只结算一次：正常拿到（或解析失败）后要清掉超时，否则进程多活 3 秒就会留下假的"超时"日志
    const timer = setTimeout(() => {
      logEvent("hook-stdin-timeout", { got: buf.length });
      res({});
    }, 3000);
    timer.unref?.();
    const settle = (value) => {
      clearTimeout(timer);
      res(value);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => {
      const text = buf.trim();
      if (!text) return settle({});
      try {
        settle(JSON.parse(text));
      } catch (err) {
        // 解析失败要留痕，否则表现为"钩子什么都没做"，极难排查
        logEvent("hook-stdin-parse-failed", { error: String(err?.message ?? err), sample: text.slice(0, 200) });
        settle({});
      }
    });
  });
}

function emit(context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: context }) + "\n");
}

async function main() {
  const payload = await readStdin();
  const sessionId = payload.sessionId ?? payload.session_id;
  const cwd = payload.cwd ?? process.env.ZCODE_PROJECT_DIR ?? process.cwd();
  const event = payload.hookEventName ?? payload.hook_event_name ?? "unknown";
  if (!sessionId) return;

  const cfg = loadConfig();
  const source = getSource("zcode");
  const session = source.getSession(sessionId);
  if (!isMainSession(session)) return;

  const workdir = session.cwd;
  const paths = store.sessionPaths(workdir, session, cfg);
  const state = store.readState(paths);
  const processed = new Set(state.processed);

  // 只读检测：有没有还没归档的压缩边界
  const pending = source.listCompactions(session.id).filter((c) => !processed.has(c.boundaryId));
  const job = readJob(session.id);
  const running = isRunning(session.id);

  const notes = [];

  // 上一次后台任务的结果反馈
  if (job && !running && job.status !== "idle") {
    if (job.reportedAt) {
      // 每次任务只播报一次。
    } else if (job.status === "done") {
      if (["total", "prepare-switch"].includes(job.mode) && job.total) {
        notes.push(`无痛切：交接已准备好：${job.total.path}\n新会话提示：\n${job.total.handoverText}`);
      } else if (cfg.announce && job.newCount > 0) {
        notes.push(`无痛切：已归档 ${job.newCount} 段对话，目录：${job.paths?.dir ?? paths.dir}`);
      }
      writeJob(session.id, { reportedAt: new Date().toISOString() });
    } else if (job.status === "error" || job.status === "stale") {
      notes.push(`无痛切：后台归档失败（不影响对话）—— ${String(job.error ?? "").split("\n")[0].slice(0, 200)}`);
      writeJob(session.id, { reportedAt: new Date().toISOString() });
    }
  }

  // 有新压缩 → 拉后台进程
  if (pending.length > 0 && !running) {
    const result = await startWorker(session.id, workdir, "scan");
    logEvent("spawn", { sessionId: session.id, pending: pending.length, pid: result.job?.pid });
  } else if (pending.length > 0 && running) {
    // 上一轮后台任务还在跑，等它结束后下一轮自然会补上（幂等由 state.json 保证）
  }

  if (notes.length > 0) {
    emit({ hookEventName: event === "Stop" ? "Stop" : "UserPromptSubmit", additionalContext: notes.join("\n") });
  }
}

const timer = setTimeout(() => {
  process.exit(0);
}, 8000);
timer.unref?.();

main()
  .catch((err) => {
    logEvent("hook-error", { error: String(err?.stack ?? err).slice(0, 500) });
  })
  .finally(() => {
    try {
      releaseDb();
    } catch {
      /* 忽略 */
    }
    clearTimeout(timer);
  });
