import { resolve } from "node:path";
import { getSource } from "./sources/index.mjs";

export function sameWorkspace(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => {
    const path = resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? path.toLowerCase() : path;
  };
  return normalize(a) === normalize(b);
}

export function isMainSession(session) {
  return Boolean(session?.id && !session.id.startsWith("sess_subagent_") && !session.id.startsWith("msg_part"));
}

export function resolveCurrentSession({ cwd, sessionId, source = getSource("zcode"), env = process.env } = {}) {
  const requestedCwd = cwd || env.ZCODE_PROJECT_DIR;
  if (sessionId) {
    const session = source.getSession(sessionId);
    if (!isMainSession(session)) throw new Error("找不到可交接的主会话。");
    if (requestedCwd && !sameWorkspace(requestedCwd, session.cwd)) {
      throw new Error("选择的会话不属于当前工作区。");
    }
    return { session, cwd: requestedCwd || session.cwd, resolvedBy: "explicit" };
  }

  for (const id of [env.ZCODE_SESSION_ID, env.CLAUDE_SESSION_ID].filter(Boolean)) {
    const session = source.getSession(id);
    if (isMainSession(session) && (!requestedCwd || sameWorkspace(requestedCwd, session.cwd))) {
      return { session, cwd: requestedCwd || session.cwd, resolvedBy: "environment" };
    }
  }

  const workdir = requestedCwd || process.cwd();
  const session = source.listSessions({ cwd: workdir, limit: 50 })
    .filter((item) => isMainSession(item) && sameWorkspace(item.cwd, workdir))
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
  if (!session) throw new Error("当前工作区还没有可交接的对话。请从有对话内容的 ZCode 会话打开无痛切。");
  return { session, cwd: workdir, resolvedBy: "latest-updated" };
}
