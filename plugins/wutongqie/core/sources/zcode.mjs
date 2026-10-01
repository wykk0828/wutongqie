// ZCode 会话源适配器。
//
// ZCode 把会话存在 ~/.zcode/cli/db/db.sqlite：
//   session(id, title, directory, time_created, time_updated)
//   message(id, session_id, sequence, time_created, data)   data 里是 {role, semantics:{kind,...}, summary?}
//   part(id, message_id, session_id, sequence, time_created, data)  data 是内容块
//
// 每次上下文压缩会写两行 part.data.type='compaction'：
//   · 操作行   —— 带 boundaryId / summaryMessageId / tail_start_id / timelineStatus
//   · 边界行   —— 带完整的 compactBoundary 对象
// 两行按 boundaryId 归并。被中断的压缩（timelineStatus='interrupted'）没有 tail_start_id，直接丢弃。
//
// 关键：tail_start_id 指向"压缩后保留下来的尾巴首条消息"。于是第 N 次压缩吞掉的段就是
//   (上一次有效压缩的尾巴 sequence - 1, 本次压缩的尾巴 sequence) 开区间。
import { openDb, makeQuery, closeDb } from "../db.mjs";
import { resolve } from "node:path";

/** 计入对话正文的 message kind。白名单之外的（todo_reminder / system_reminder / 后台通知 / 分隔线）一律不进归档。 */
const TRANSCRIPT_KINDS = new Set(["user_prompt", "assistant_response"]);

const SUBAGENT = "sess_subagent_";

let cached = null;
function conn() {
  if (!cached) {
    const db = openDb();
    cached = { db, q: makeQuery(db) };
  }
  return cached;
}
export function releaseDb() {
  if (cached) {
    closeDb(cached.db);
    cached = null;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stamp(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

export const zcodeSource = {
  id: "zcode",
  name: "ZCode",
  default: true,

  /** 工作区下的主会话，最新的在前。 */
  listSessions({ cwd, limit = 30, includeSubagents = false } = {}) {
    const { q } = conn();
    const where = ["id NOT LIKE ?"];
    const args = [`${SUBAGENT}%`];
    if (!includeSubagents) where.push("id NOT LIKE ?"), args.push("msg_part%");
    if (cwd) {
      if (process.platform === "win32") {
        where.push("replace(rtrim(directory, '/\\'), char(92), '/') = ? COLLATE NOCASE");
        args.push(resolve(cwd).replace(/\\/g, "/").replace(/\/+$/, ""));
      } else {
        where.push("directory = ?");
        args.push(resolve(cwd));
      }
    }
    const rows = q(
      `SELECT id, title, directory, time_created, time_updated, slug, version
         FROM session
        WHERE ${where.join(" AND ")}
        ORDER BY time_updated DESC
        LIMIT ?`,
      ...args,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title || "(无标题)",
      cwd: r.directory,
      createdAt: stamp(r.time_created),
      updatedAt: stamp(r.time_updated),
    }));
  },

  getSession(sessionId) {
    const { q } = conn();
    const r = q.one(
      `SELECT id, title, directory, time_created, time_updated, slug
         FROM session WHERE id = ?`,
      sessionId,
    );
    if (!r) return null;
    return {
      id: r.id,
      title: r.title || "(无标题)",
      slug: r.slug,
      cwd: r.directory,
      createdAt: stamp(r.time_created),
      updatedAt: stamp(r.time_updated),
    };
  },

  /** 最新消息的 sequence，用来切"仍在上下文里的活跃尾巴"。 */
  maxSequence(sessionId) {
    const { q } = conn();
    const r = q.one(`SELECT max(sequence) AS mx FROM message WHERE session_id = ?`, sessionId);
    return r?.mx ?? -1;
  },

  /**
   * 归一化后的压缩边界列表，按时间升序。
   * 每项：{ boundaryId, time, startedAt, trigger, phase, compactReason,
   *         preCompactTokenCount, postCompactTokenCount, summarizedMessageCount,
   *         keptMessageCount, tailMessageId, tailSequence, summaryMessageIds, officialSummary }
   */
  listCompactions(sessionId) {
    const { q } = conn();
    const rows = q(
      `SELECT time_created, data FROM part
        WHERE session_id = ?
          AND json_extract(data, '$.type') = 'compaction'
        ORDER BY time_created ASC`,
      sessionId,
    );

    const groups = new Map();
    for (const row of rows) {
      const d = parseJson(row.data);
      if (!d) continue;
      const b = d.compactBoundary ?? null;
      const boundaryId = b?.boundaryId ?? d.boundaryId ?? null;
      if (!boundaryId) continue; // 没有 boundaryId 的行（多为中断的操作行）无法归档，跳过
      const g = groups.get(boundaryId) ?? {
        boundaryId,
        startedAt: row.time_created,
        time: row.time_created,
        tailMessageId: null,
        tailSequence: null,
        summaryMessageIds: [],
        officialSummary: null,
        trigger: null,
        phase: null,
        compactReason: null,
        preCompactTokenCount: null,
        postCompactTokenCount: null,
        summarizedMessageCount: null,
        keptMessageCount: null,
      };
      g.startedAt = Math.min(g.startedAt, row.time_created);
      // 边界行（带 compactBoundary）写在操作行之后，用它的时间戳作为权威时间
      if (b) g.time = row.time_created;
      else g.time = Math.max(g.time, row.time_created);
      if (d.tail_start_id) g.tailMessageId = d.tail_start_id;
      if (d.summaryMessageId && !g.summaryMessageIds.includes(d.summaryMessageId)) {
        g.summaryMessageIds.push(d.summaryMessageId);
      }
      if (b) {
        g.trigger = b.trigger ?? d.trigger ?? null;
        g.phase = b.phase ?? d.phase ?? null;
        g.compactReason = b.compactReason ?? d.compactReason ?? null;
        g.preCompactTokenCount = b.preCompactTokenCount ?? d.preCompactTokenCount ?? null;
        g.postCompactTokenCount = b.postCompactTokenCount ?? d.postCompactTokenCount ?? null;
        g.summarizedMessageCount = b.summarizedMessageCount ?? null;
        g.keptMessageCount = b.keptMessageCount ?? null;
        for (const id of b.summaryMessageIds ?? []) {
          if (!g.summaryMessageIds.includes(id)) g.summaryMessageIds.push(id);
        }
      } else {
        g.trigger = g.trigger ?? d.trigger ?? null;
        g.phase = g.phase ?? d.phase ?? null;
        g.compactReason = g.compactReason ?? d.compactReason ?? null;
        g.preCompactTokenCount = d.preCompactTokenCount ?? g.preCompactTokenCount;
        g.postCompactTokenCount = d.postCompactTokenCount ?? g.postCompactTokenCount;
      }
      groups.set(boundaryId, g);
    }

    const list = [...groups.values()].sort((a, b) => a.startedAt - b.startedAt);

    // 解析尾巴消息的 sequence，并附上 ZCode 自己生成的压缩摘要正文
    for (const g of list) {
      if (g.tailMessageId) {
        const m = q.one(`SELECT sequence FROM message WHERE id = ? AND session_id = ?`, g.tailMessageId, sessionId);
        g.tailSequence = m?.sequence ?? null;
      }
      const sid = g.summaryMessageIds[0];
      if (sid) {
        const m = q.one(`SELECT data FROM message WHERE id = ? AND session_id = ?`, sid, sessionId);
        const d = m ? parseJson(m.data) : null;
        g.officialSummary = d?.summary?.body ?? null;
        g.officialSummaryTitle = d?.summary?.title ?? null;
      }
    }

    // 尾巴解析不出来的边界无法定位切点，丢弃
    return list.filter((g) => typeof g.tailSequence === "number").map((g) => ({
      ...g,
      startedAt: stamp(g.startedAt),
      time: stamp(g.time),
    }));
  },

  /**
   * 取 sequence 开区间 (fromSeq, toSeq) 内的对话消息。
   * fromSeq 传 -1 表示从会话开头算起。
   */
  getSegment(sessionId, fromSeq, toSeq) {
    const { q } = conn();
    const messages = q(
      `SELECT id, sequence, time_created, data FROM message
        WHERE session_id = ? AND sequence > ? AND sequence < ?
        ORDER BY sequence ASC`,
      sessionId,
      fromSeq,
      toSeq,
    );
    if (messages.length === 0) return { messages: [], parts: new Map(), stats: emptyStats() };

    const byId = new Map();
    const transcript = [];
    let hidden = 0;
    for (const m of messages) {
      const d = parseJson(m.data) ?? {};
      const kind = d.semantics?.kind ?? null;
      byId.set(m.id, { ...m, meta: d, parts: [] });
      if (kind === "compact_summary") {
        hidden++;
        transcript.push({
          id: m.id,
          sequence: m.sequence,
          time: m.time_created,
          role: "user",
          kind,
          special: "official-summary",
          title: d.summary?.title ?? "Compact summary",
          text: d.summary?.body ?? "",
        });
      } else if (TRANSCRIPT_KINDS.has(kind)) {
        transcript.push({ id: m.id, sequence: m.sequence, time: m.time_created, role: d.role ?? kind, kind, special: null });
      } else {
        hidden++;
      }
    }

    // 取 part，按 message 分组；分批以避开 SQL 变量数上限
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += 400) {
      const slice = ids.slice(i, i + 400);
      const placeholders = slice.map(() => "?").join(",");
      const rows = q(
        `SELECT message_id, sequence, data FROM part
          WHERE session_id = ? AND message_id IN (${placeholders})
          ORDER BY message_id, sequence`,
        sessionId,
        ...slice,
      );
      for (const r of rows) {
        const target = byId.get(r.message_id);
        if (target) target.parts.push({ sequence: r.sequence, data: parseJson(r.data) });
      }
    }

    let userCount = 0;
    let assistantCount = 0;
    let toolCount = 0;
    for (const m of transcript) {
      if (m.special === "official-summary") {
        m.parts = byId.get(m.id)?.parts ?? [];
        continue;
      }
      const raw = byId.get(m.id)?.parts ?? [];
      m.parts = raw;
      for (const p of raw) {
        if (p.data?.type === "tool") toolCount++;
      }
      if (m.role === "user") userCount++;
      else assistantCount++;
    }

    return {
      messages: transcript,
      stats: {
        fromSeq,
        toSeq,
        totalRows: messages.length,
        userCount,
        assistantCount,
        toolCount,
        hiddenRows: hidden,
      },
    };
  },
};

function emptyStats() {
  return { fromSeq: null, toSeq: null, totalRows: 0, userCount: 0, assistantCount: 0, toolCount: 0, hiddenRows: 0 };
}
