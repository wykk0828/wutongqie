// 归档文件的落盘布局与读写。
//
//   <outputRoot>/
//     README.md                      自动生成，说明这个目录是什么
//     index.json                     全局索引
//     sessions/<会话名-sess_xxxx>/
//       meta.json                    会话元信息
//       state.json                   已处理的 boundaryId / 段计数（幂等依据）
//       01-20260930-1342.md          段摘要
//       ...
//       LIVE.md                      仍在上下文里的活跃尾巴
//       raw/01-20260930-1342.md      被压缩掉的完整原文
//       TOTAL.md                     合并出的总对话摘要
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { logEvent, outputRootFor } from "./config.mjs";

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Windows 文件名安全化。保留中文，砍掉非法字符和设备名。 */
export function safeName(input, fallback = "untitled") {
  let s = String(input ?? "").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/[. ]+$/, "");
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 80);
}

export function sessionSlug(session) {
  const short = String(session.id).replace(/^sess_/, "").slice(0, 8);
  return `${safeName(session.title || "未命名会话", "未命名会话")}-${short}`;
}

/**
 * 会话目录定位：先按「标题-短ID」精确匹配；未命中时扫描各目录 meta.json 按 sessionId 兜底。
 * 目录被手动改名、或会话标题变化导致 slug 漂移后，仍能找回原归档继续写入，
 * 不会另起新目录造成数据分裂。多个候选（如改名目录与同名目录并存）时取最近写入的一个。
 */
export function resolveSessionDir(root, session) {
  const sessionsDir = join(root, "sessions");
  const slug = sessionSlug(session);
  const canonical = join(sessionsDir, slug);
  let names = [];
  try {
    if (existsSync(sessionsDir)) names = readdirSync(sessionsDir);
  } catch {
    /* 列目录失败时按新会话处理 */
  }
  if (!session?.id || !names.length) return canonical;

  const candidates = [];
  for (const name of names) {
    if (name === slug) {
      candidates.push(canonical);
      continue;
    }
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(join(sessionsDir, name, "meta.json"), "utf8"));
    } catch {
      continue;
    }
    if (meta?.sessionId === session.id) candidates.push(join(sessionsDir, name));
  }
  if (candidates.length === 0) return canonical;
  if (candidates.length === 1) return candidates[0];

  // 多个候选（例如改名目录之外又出现了同名目录、或存在备份副本）：按最近写入选择，
  // 避免把新内容写进旧副本。state.json 的 mtime 最能代表活跃写入者。
  const activity = (dir) => {
    for (const file of ["state.json", "meta.json"]) {
      try {
        return statSync(join(dir, file)).mtimeMs;
      } catch {
        /* 尝试下一个依据 */
      }
    }
    try {
      return statSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  };
  candidates.sort((a, b) => activity(b) - activity(a));
  logEvent("session-dir-ambiguous", { sessionId: session.id, picked: candidates[0], alternatives: candidates.length - 1 });
  return candidates[0];
}

export function sessionPaths(cwd, session, cfg) {
  const root = outputRootFor(cwd, cfg);
  const dir = resolveSessionDir(root, session);
  return {
    root,
    dir,
    rawDir: join(dir, "raw"),
    meta: join(dir, "meta.json"),
    state: join(dir, "state.json"),
    total: join(dir, "TOTAL.md"),
    live: join(dir, "LIVE.md"),
    index: join(root, "index.json"),
    readme: join(root, "README.md"),
  };
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖目标。
 * 读方永远看到完整旧文件或完整新文件，不会读到写了一半的内容。
 * （Windows 的 rename 同样会覆盖已存在的目标文件。）
 */
export function atomicWrite(file, data) {
  ensureDir(dirname(file));
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, data, "utf8");
    renameSync(temp, file);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* 临时文件清理失败不影响已完成的写入 */
    }
  }
  return file;
}

/** 内容哈希：用于校验归档文件、TOTAL.md 是否被删除/改动。 */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 文件实际内容的哈希；文件不存在或读失败返回 null。 */
export function fileContentHash(file) {
  try {
    return existsSync(file) ? sha256(readFileSync(file)) : null;
  } catch {
    return null;
  }
}

/** 解析 ISO 时间；无效值回退 fallback（合并并发写入时用）。 */
export function stateTime(value, fallback = 0) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : fallback;
}

function writeJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}

export function emptyState() {
  return {
    processed: [], // 已归档的 boundaryId 列表
    chunkIndex: 0, // 下一个段编号
    liveThroughSequence: null, // LIVE 段已覆盖到的 message sequence
    liveBoundaryId: null, // LIVE 段所属的压缩边界（null = 会话尚未压缩过）
    liveInputHash: null, // 当前 LIVE 输入内容指纹
    liveSummary: null, // 最近一次 LIVE 摘要及其输入指纹
    liveUpdatedAt: null, // live* 字段最后一次写入时间（并发合并时取新）
    totalBuiltAt: null,
    totalInputChars: null,
    totalSourceFiles: null, // 生成 TOTAL 时使用的压缩段文件快照（含内容哈希）
    totalLiveInputHash: null, // 生成 TOTAL 时纳入的 LIVE 输入指纹
    totalConfigKey: null, // 影响 TOTAL 内容的配置快照
    totalRollingCount: 0, // 距上次全量重建已经滚动归并过几次
    totalContentHash: null, // TOTAL.md 落盘内容的 sha256（删除/损坏时拒绝命中缓存）
    total: null, // 当前发布的交接结果（draft/fallback/final 都可能是它）
    rollingBase: null, // 上一版"模型成功生成"的最终正文与来源快照，供滚动归并使用
    draft: null, // 后台整理期间可立即复制的机械草稿
    draftBuiltAt: null,
    lastFinalTotal: null, // 最后一版模型成功生成的交接（草稿覆盖 TOTAL.md 后仍保留）
  };
}

export function readState(paths) {
  return { ...emptyState(), ...readJson(paths.state, {}) };
}

export function writeState(paths, state) {
  writeJson(paths.state, state);
}

export function readTotalText(paths) {
  try {
    return existsSync(paths.total) ? readFileSync(paths.total, "utf8") : null;
  } catch {
    return null;
  }
}

/** TOTAL.md 实际内容的哈希；不存在返回 null。 */
export function totalContentHash(paths) {
  return fileContentHash(paths.total);
}

/* 并发写入时按 builtAt 择新的状态字段组。scan 的中间态、面板的草稿、后台最终版
   可能交错落盘，谁都不允许用旧值覆盖较新的结果。 */
const TOTAL_BUNDLE = [
  "total",
  "totalBuiltAt",
  "totalInputChars",
  "totalThroughSequence",
  "totalSourceFiles",
  "totalLiveInputHash",
  "totalConfigKey",
  "totalRollingCount",
  "totalContentHash",
];
const LIVE_BUNDLE = ["liveThroughSequence", "liveBoundaryId", "liveInputHash", "liveSummary", "liveUpdatedAt"];

/**
 * 合并写入 state.json（原子）。规则：
 *   1. processed 取并集、chunkIndex 取最大：归档进度只增不减，草稿不得回退 scan 的进度；
 *   2. total / lastFinalTotal / rollingBase / live* / draft 各字段组按 builtAt 取较新的一侧；
 *   3. 当最终版（total 或 lastFinalTotal）严格新于草稿时，草稿自动作废。
 * 调用方只需传入"自己想写的字段"，其余字段自动继承磁盘上的较新版本。
 */
export function mergeState(paths, patch = {}) {
  const latest = readState(paths);
  const local = { ...emptyState(), ...patch };
  const next = { ...latest, ...local };

  const processed = [];
  const seen = new Set();
  for (const id of [...(local.processed ?? []), ...(latest.processed ?? [])]) {
    if (typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      processed.push(id);
    }
  }
  next.processed = processed;
  next.chunkIndex = Math.max(Number(local.chunkIndex) || 0, Number(latest.chunkIndex) || 0);

  const pick = (fields, localAt, latestAt) => {
    const localPresent = fields.some((field) => local[field] != null);
    const latestPresent = fields.some((field) => latest[field] != null);
    const useLatest = localPresent && latestPresent ? Number(latestAt) > Number(localAt) : !localPresent && latestPresent;
    const source = useLatest ? latest : local;
    for (const field of fields) next[field] = source[field];
  };

  pick(TOTAL_BUNDLE, stateTime(local.totalBuiltAt ?? local.total?.builtAt), stateTime(latest.totalBuiltAt ?? latest.total?.builtAt));
  pick(["lastFinalTotal"], stateTime(local.lastFinalTotal?.builtAt), stateTime(latest.lastFinalTotal?.builtAt));
  pick(["rollingBase"], stateTime(local.rollingBase?.builtAt), stateTime(latest.rollingBase?.builtAt));
  pick(LIVE_BUNDLE, stateTime(local.liveUpdatedAt), stateTime(latest.liveUpdatedAt));
  pick(["draft", "draftBuiltAt"], stateTime(local.draftBuiltAt ?? local.draft?.builtAt), stateTime(latest.draftBuiltAt ?? latest.draft?.builtAt));

  const finalAt = Math.max(stateTime(next.totalBuiltAt ?? next.total?.builtAt), stateTime(next.lastFinalTotal?.builtAt));
  const draftAt = stateTime(next.draftBuiltAt ?? next.draft?.builtAt);
  if (next.draft && finalAt > draftAt) {
    next.draft = null;
    next.draftBuiltAt = null;
  }
  if (!next.draft) next.draftBuiltAt = null;

  writeState(paths, next);
  return next;
}

export function writeMeta(paths, session, extra = {}) {
  const existing = readJson(paths.meta, {});
  const meta = {
    sessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    source: "zcode",
    ...existing,
    ...extra,
  };
  writeJson(paths.meta, meta);
  return meta;
}

export function readMeta(paths) {
  return readJson(paths.meta, null);
}

export function writeChunk(paths, filename, markdown) {
  return atomicWrite(join(paths.dir, filename), markdown);
}

export function writeRaw(paths, filename, markdown) {
  return atomicWrite(join(paths.rawDir, filename), markdown);
}

export function repairFile(paths, filename) {
  if (!/^\d{2,}-\d{8}-\d{4}\.md$/.test(filename)) throw new Error("无效的修复摘要文件名。");
  return join(paths.dir, "repairs", `${filename}.json`);
}

export function readRepair(paths, filename) {
  return readJson(repairFile(paths, filename), null);
}

export function writeRepair(paths, filename, payload) {
  const file = repairFile(paths, filename);
  const serialized = JSON.stringify(payload, null, 2) + "\n";
  if (existsSync(file)) {
    const previous = readFileSync(file);
    if (previous.equals(Buffer.from(serialized))) return file;
    const backup = join(paths.dir, "repairs", "backup", `${filename}.${sha256(previous)}.bak`);
    if (!existsSync(backup)) atomicWrite(backup, previous);
    if (fileContentHash(backup) !== sha256(previous)) throw new Error("旧修复文件备份校验失败，未替换摘要。");
  }
  atomicWrite(file, serialized);
  return file;
}

const CHUNK_RE = /^\d{2,}-\d{8}-\d{4}\.md$/;

export function listChunkFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => CHUNK_RE.test(f))
    .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
}

/** 段摘要 + LIVE + TOTAL 的完整清单，供总摘要与面板使用。 */
export function listChunks(paths) {
  const items = listChunkFiles(paths.dir).map((file) => {
    const full = join(paths.dir, file);
    let mtime = null;
    try {
      mtime = new Date(statSync(full).mtimeMs).toISOString();
    } catch {
      /* 忽略 */
    }
    return { file, path: full, mtime, live: false };
  });
  if (existsSync(paths.live)) {
    items.push({ file: "LIVE.md", path: paths.live, mtime: new Date(statSync(paths.live).mtimeMs).toISOString(), live: true });
  }
  return items;
}

export function readChunkText(paths, file) {
  const safe = safeName(file, "");
  if (!safe) throw new Error(`非法的文件名: ${file}`);
  const full = join(paths.dir, safe);
  if (!existsSync(full)) throw new Error(`找不到归档文件: ${safe}`);
  return readFileSync(full, "utf8");
}

export function writeTotal(paths, markdown) {
  return atomicWrite(paths.total, markdown);
}

export function writeLive(paths, markdown) {
  return atomicWrite(paths.live, markdown);
}

export function hasTotal(paths) {
  return existsSync(paths.total);
}

const README_TEXT = `# 无痛切归档目录

这个目录由 ZCode 插件 **无痛切 (wutongqie)** 自动生成，不要手工编辑或提交到 git。

- \`sessions/<会话名-sess_xxxx>/NN-YYYYMMDD-HHMM.md\` — 一次上下文压缩归档下来的**段摘要**。
  每次上下文被压缩时，上一次压缩到这一次之间被丢弃的对话会自动提取、总结并存到这里。
  目录按 \`meta.json\` 里的会话 ID 识别：手动改名或会话标题变化后仍会找到原归档，不会分裂数据。
- \`sessions/.../LIVE.md\` — 当前未压缩的对话内容。点击「准备切换会话」时一并纳入交接文档。
- \`sessions/.../raw/NN-*.md\` — 被压缩掉的对话正文，工具输出为有界预览，供你自己检索细节用。
- \`sessions/.../repairs/NN-*.md.json\` — 失败段摘要的修复结果；原始段文件保持不变。
- \`sessions/.../TOTAL.md\` — 交接文档。准备换会话时，在对话里输入 \`/change\` 或点击面板的「准备切换会话」，复制生成的新会话提示即可接续。

## 关于「准备切换会话」

- 点击后**立即返回**：没有新内容时直接复用已有 \`TOTAL.md\`（不调模型、不重写文件）；
  有新内容时先写出一份**机械拼接的草稿**（明确标注「草稿 · 后台继续完善」），你立刻就能复制。
- 同时后台任务会用模型归并，完成后**覆盖同一个 \`TOTAL.md\`**；你复制的路径不变，稍后打开就是最终版。
- 模型暂时不可用时，会保留草稿或上一版结果，并在下一次准备交接时自动重试。

生成时间：${new Date().toISOString()}
`;

export function writeRootReadme(paths) {
  if (existsSync(paths.readme)) return false;
  atomicWrite(paths.readme, README_TEXT);
  return true;
}

/** 全局索引：给面板和 MCP 列表用。 */
export function rebuildIndex(root) {
  const sessionsDir = join(root, "sessions");
  if (!existsSync(sessionsDir)) return { root, updatedAt: new Date().toISOString(), sessions: [] };
  const sessions = readdirSync(sessionsDir)
    .map((slug) => {
      const dir = join(sessionsDir, slug);
      let meta = null;
      try {
        meta = readJson(join(dir, "meta.json"), null);
      } catch {
        meta = null;
      }
      if (!meta) return null;
      const chunks = listChunkFiles(dir).map((f) => {
        let size = 0;
        let mtime = null;
        try {
          size = statSync(join(dir, f)).size;
          mtime = new Date(statSync(join(dir, f)).mtimeMs).toISOString();
        } catch {
          /* 忽略 */
        }
        return { file: f, size, mtime };
      });
      const totalPath = join(dir, "TOTAL.md");
      let total = null;
      if (existsSync(totalPath)) {
        const st = statSync(totalPath);
        total = { file: "TOTAL.md", size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
      }
      const livePath = join(dir, "LIVE.md");
      const live = existsSync(livePath)
        ? { file: "LIVE.md", size: statSync(livePath).size, mtime: new Date(statSync(livePath).mtimeMs).toISOString() }
        : null;
      const state = readJson(join(dir, "state.json"), {});
      return {
        slug,
        sessionId: meta.sessionId,
        title: meta.title,
        cwd: meta.cwd,
        updatedAt: meta.updatedAt,
        chunkCount: chunks.length,
        chunks,
        live,
        total,
        processedCount: (state.processed ?? []).length,
        totalBuiltAt: state.totalBuiltAt ?? total?.mtime ?? null,
        totalInputChars: state.totalInputChars ?? null,
        totalThroughSequence: state.totalThroughSequence ?? null,
        handover: state.total ?? null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

  const index = { root, updatedAt: new Date().toISOString(), sessions };
  writeJson(join(root, "index.json"), index);
  return index;
}

export { outputRootFor, unlinkSync };
