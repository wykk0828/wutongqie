"use strict";

/* ==========================================================================
   无痛切 · 面板前端（安静的工具型页面）
   主流程只有三步：正常干活（归档自动完成）→ 点「准备切换会话」→ 把提示复制到新会话。

   后端契约（面板 HTTP 服务）：
     GET  /api/state[?sessionId=&cwd=]
          -> { cwd, boundCwd, root, config, providers, log, sessions[], unarchived[],
               choices[{sessionId,title,updatedAt}], current{sessionId,title,updatedAt,resolvedBy,
               slug,dir,chunkCount,job,draft,handover,stale}, currentError? }
     GET  /api/job?sessionId= -> { ok, sessionId, job, draft, handover, stale }
     POST /api/prepare-switch { sessionId, cwd } -> { ok, sessionId, status, job, draft, handover, existing?, reused? }
     GET  /api/session?slug=      /api/chunk?slug=&file=
     POST /api/archive {sessionId}  /api/open-folder {path}
     POST /api/config {patch}       /api/shutdown
   job: { status:'queued'|'running'|'done'|'error'|'stale', mode:'scan'|'prepare-switch'|'total',
          phase:'queued'|'archive'|'live'|'merge'|'save'|'done', progress, count, startedAt,
          finishedAt, error, total }
   handover: { path, totalPath, builtAt, sessionTitle, liveIncluded, warnings[], handoverText,
               highlights{overview,conclusions,constraints}, chunkCount, passes, usage, model }
   ========================================================================== */

/* ---------- 环境 ---------- */

const TOKEN = window.__WTQ_TOKEN;
const BOUND_CWD = typeof window.__WTQ_CWD === "string" ? window.__WTQ_CWD : "";
/* 打开面板时后端注入的会话 id（可选）。默认不主动使用：让后端按「绑定会话 / 环境变量 / 最近活动」
   自己解析，只在后端报「找不到会话」时作为兜底选项提示用户。 */
const OPEN_SESSION_ID = (() => {
  const v = window.__WTQ_SESSION_ID;
  return typeof v === "string" && /^sess[-_]/.test(v) ? v : "";
})();

const PIN_KEY = "wtq.pinnedSessionId";
const POLL_RUNNING_MS = 2000;
const POLL_IDLE_MS = 10000;

const ACTIVE_MODES = new Set(["prepare-switch", "total"]);
const PHASE_LABEL = {
  queued: "已排队，马上开始",
  archive: "正在整理当前对话",
  live: "正在整理未压缩内容",
  merge: "正在生成交接文档",
  save: "正在保存交接文档",
  done: "正在收尾",
};

const SETTINGS_FIELDS = [
  { key: "llmProviderId", label: "模型供应商", type: "provider", desc: "留空 = 自动挑一个可用的。密钥复用 ZCode 的配置，不用另填。" },
  { key: "llmModelId", label: "模型", type: "text", desc: "留空 = 用该供应商的第一个模型。" },
  { key: "outputRoot", label: "归档根目录", type: "text", desc: "留空 = 每个工作区各自的 <工作区>/.无痛切/。" },
  { key: "saveRaw", label: "保存被压缩掉的原文", type: "bool", desc: "关掉可以省磁盘，raw/ 目录不再生成。正文不截断，工具输出只保留有界预览。" },
  { key: "announce", label: "归档时在对话里播报", type: "bool", desc: "默认关（静默归档）。开启后每次压缩归档完会告诉你存到哪了。" },
  { key: "maxTranscriptChars", label: "单次摘要的原文上限（字符）", type: "number", desc: "超过就自动分块，把原文完整送进多次请求，不再裁剪正文或省略中段。" },
  { key: "mergeBudgetChars", label: "总摘要单层归并预算（字符）", type: "number", desc: "段太多时按这个预算分批归并再汇总，超预算不丢内容。" },
  { key: "summaryContextTokens", label: "单次摘要的上下文预算（tokens）", type: "number", min: "1", step: "1", desc: "每次摘要请求的安全预算，含提示词，按 UTF-8 字节保守估算：不是精确 tokenizer，也不是模型容量上限。" },
  { key: "summaryOutputTokens", label: "单次摘要的输出预算（tokens）", type: "number", min: "1", step: "1", desc: "要求模型每次最多输出多少 token；上下文预算必须大于输出预算 + 1536。输出太小可能截断，完整缩块重试仍失败时保留原文。" },
];

/* ---------- 基础工具 ---------- */

const $ = (id) => document.getElementById(id);

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status || 0;
  }
}

async function api(path, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(path, {
      method: opts.method ?? "GET",
      signal: ctl.signal,
      headers: { "X-WTQ-Token": TOKEN, "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: opts.body,
    });
    const text = await res.text();
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = {};
      }
    }
    if (!res.ok) throw new ApiError(json.error || `HTTP ${res.status}`, res.status);
    return json;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === "AbortError") throw new ApiError("请求超时，面板没有响应", 0);
    throw new ApiError(`无法连接面板：${err?.message ?? err}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** 极简 DOM 构造器：一律用 textContent，模型输出永远不会被当成 HTML。 */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "hidden") node.hidden = Boolean(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(4)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const icon = (name, cls) => h("i", { "data-lucide": name, class: cls || null, "aria-hidden": "true" });

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 只在内容真的变了才写 textContent：轮询时不会打断用户选中文本。 */
function setText(node, value) {
  const next = value == null ? "" : String(value);
  if (node.textContent !== next) node.textContent = next;
}

function refreshIcons(root) {
  try {
    window.lucide?.createIcons?.({ root: root ?? document });
  } catch {
    /* 图标只是装饰，失败不影响功能 */
  }
}

function fmtTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso).slice(0, 19).replace("T", " ");
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? `今天 ${clock}` : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function truncate(value, n) {
  const s = String(value ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function toast(message, kind = "") {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => (node.hidden = true), kind === "bad" ? 8000 : 3500);
}

function announce(message) {
  setText($("live"), message);
}

/* ---------- 全局 UI 状态 ---------- */

const UI = {
  state: null,
  pinned: readPinned(),
  conn: null, // { message, status }
  authBroken: false,
  stopped: false, // 面板进程已关闭，停止一切轮询
  firstLoad: false,
  optimistic: null, // { job, until }  点完按钮后立刻显示的进行中状态
  localError: null, // { message, at }  面板请求本身的失败（GET /api/state 里看不到）
  view: "", // 当前状态面板类型，用于状态切换时的播报
  sigs: {}, // 各列表签名，避免轮询无意义重画
  pollTimer: null,
  settings: { mounted: false, dirty: false, saving: false, ctl: {}, provSig: "", cfgSig: "" },
  doc: null, // { slug, file, title, dir }
  docSeq: 0, // 预览请求代数：只有最后一次请求的响应允许写回对话框
  confirmResolve: null,
  lastFocus: null,
  prepareBusy: false,
};

function readPinned() {
  try {
    const fromUrl = new URL(location.href).searchParams.get("sessionId");
    if (fromUrl) return fromUrl; // URL 里的选择只对本次生效，不写回本地记忆
  } catch {
    /* 忽略 */
  }
  try {
    return localStorage.getItem(PIN_KEY) || "";
  } catch {
    return "";
  }
}

function resetSessionScopedState() {
  UI.optimistic = null;
  UI.localError = null;
  UI.view = "";
  UI.sigs = {};
}

/* ---------- 轮询 ---------- */

function isActiveJob(job) {
  return Boolean(job && (job.status === "queued" || job.status === "running") && ACTIVE_MODES.has(job.mode));
}

function isRunningJob(job) {
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

function schedulePoll(delay) {
  clearTimeout(UI.pollTimer);
  if (UI.authBroken || UI.stopped) return;
  const active = isActiveJob(currentJob());
  const wait = delay ?? (active ? POLL_RUNNING_MS : POLL_IDLE_MS);
  UI.pollTimer = setTimeout(() => (active ? pollActiveJob() : refresh({ silent: true })), wait);
}

async function pollActiveJob() {
  if (UI.authBroken || UI.stopped) return;
  const cur = currentSession();
  const active = currentJob();
  if (!cur?.sessionId || !isActiveJob(active)) return void refresh({ silent: true });
  const params = new URLSearchParams({ sessionId: cur.sessionId });
  if (BOUND_CWD) params.set("cwd", BOUND_CWD);
  let terminal = false;
  try {
    const next = await api(`/api/job?${params.toString()}`, { timeoutMs: 10000 });
    const nextJob = next.job ?? null;
    const previousJob = UI.state?.current?.job ?? null;
    if (UI.state?.current) {
      UI.state.current = {
        ...UI.state.current,
        job: nextJob,
        draft: next.draft ?? UI.state.current.draft ?? null,
        handover: next.handover ?? UI.state.current.handover ?? null,
        stale: next.stale ?? UI.state.current.stale,
      };
    }
    UI.conn = null;
    if (UI.optimistic && nextJob) {
      const sameJob = !UI.optimistic.job.jobId || UI.optimistic.job.jobId === nextJob.jobId;
      if (sameJob) UI.optimistic = null;
    }
    terminal = Boolean(nextJob && !isActiveJob(nextJob) && ["done", "error", "stale"].includes(nextJob.status));
    if (terminal) {
      // 任务结束时只做一次完整刷新，让最终 TOTAL、索引和列表状态一起切换。
      await refresh({ silent: true });
      return;
    }
    render();
  } catch (err) {
    if (err.status === 404) {
      // 兼容旧面板进程或旧测试夹具：轻量接口不存在时退回完整刷新。
      await refresh({ silent: true });
      return;
    }
    UI.conn = { message: err.message, status: err.status };
    if (err.status === 403) {
      UI.authBroken = true;
      clearTimeout(UI.pollTimer);
    }
    renderBanners();
    renderPrepare();
  } finally {
    if (!terminal) schedulePoll();
  }
}

function currentJob() {
  const cur = UI.state?.current;
  const job = cur?.job ?? null;
  const opt = UI.optimistic;
  if (opt && Date.now() < opt.until) {
    const sameJob = job && ACTIVE_MODES.has(job.mode) && (!opt.job.jobId || job.jobId === opt.job.jobId);
    if (!sameJob) return opt.job;
  }
  return job;
}

async function refresh({ silent = false } = {}) {
  if (UI.authBroken || UI.stopped) return;
  try {
    const params = new URLSearchParams();
    if (UI.pinned) params.set("sessionId", UI.pinned);
    if (BOUND_CWD) params.set("cwd", BOUND_CWD);
    const qs = params.toString();
    const next = await api(`/api/state${qs ? `?${qs}` : ""}`);

    // 乐观状态 / 本地错误在拿到真实状态后清理
    if (UI.optimistic) {
      const job = next.current?.job;
      const stateActive = job && (job.status === "queued" || job.status === "running") && ACTIVE_MODES.has(job.mode);
      const builtAt = Date.parse(next.current?.handover?.builtAt ?? "");
      const sameJob = job && ACTIVE_MODES.has(job.mode) && (!UI.optimistic.job.jobId || job.jobId === UI.optimistic.job.jobId);
      if (stateActive || sameJob || (Number.isFinite(builtAt) && builtAt >= UI.optimistic.at) || !next.current?.job) UI.optimistic = null;
    }
    if (UI.localError) {
      const job = next.current?.job;
      const stateActive = job && (job.status === "queued" || job.status === "running") && ACTIVE_MODES.has(job.mode);
      const finishedAt = Date.parse(job?.finishedAt ?? "");
      const builtAt = Date.parse(next.current?.handover?.builtAt ?? "");
      if (stateActive || finishedAt > UI.localError.at || builtAt > UI.localError.at) UI.localError = null;
    }

    UI.state = next;
    UI.conn = null;
    render();
    if (!silent && UI.firstLoad) announce("已刷新");
  } catch (err) {
    UI.conn = { message: err.message, status: err.status };
    if (err.status === 403) {
      UI.authBroken = true;
      clearTimeout(UI.pollTimer);
    }
    renderBanners();
    renderPrepare();
  } finally {
    UI.firstLoad = true;
    schedulePoll();
  }
}

/* ---------- 数据视图判断 ---------- */

function currentSession() {
  return UI.state?.current ?? null;
}

/** 主状态面板当前该显示什么。 */
function jobView() {
  const cur = currentSession();
  const job = currentJob();
  const draft = cur?.draft ?? job?.draft ?? null;
  const handover = cur?.handover ?? job?.total ?? job?.handover ?? null;
  const active = job && (job.status === "queued" || job.status === "running") && ACTIVE_MODES.has(job.mode);
  const failed = job && (job.status === "error" || job.status === "stale") && ACTIVE_MODES.has(job.mode);

  if (active) return { kind: "running", job, draft, handover };
  // 连会话都解析不出来时，由横幅统一说明原因，主面板保持安静
  if (!cur && UI.state?.currentError && !handover && !draft) return { kind: "idle", job: null, cur: null };
  const message = UI.localError?.message || (failed ? job.error || "后台任务失败（没有错误详情）" : "");
  if (message) return { kind: "error", message, draft, handover, job: failed ? job : null };
  if (handover) return { kind: "success", handover };
  return { kind: "idle", job, cur };
}

function jobPercent(job) {
  let p = Number(job?.progress);
  if (!Number.isFinite(p) || p <= 0) {
    const count = job?.count;
    if (count && typeof count === "object") {
      const done = Number(count.done ?? count.current);
      const total = Number(count.total ?? count.max);
      if (Number.isFinite(done) && Number.isFinite(total) && total > 0) p = done / total;
    }
  }
  if (!Number.isFinite(p) || p <= 0) return null;
  const count = job?.count;
  const pct = typeof count === "number" && count > 0 ? p / count * 100 : p <= 1 ? p * 100 : p;
  return Math.max(3, Math.min(100, Math.round(pct)));
}

function jobCountText(job) {
  const count = job?.count;
  if (count == null) return "";
  if (typeof count === "number") return `已处理 ${job.progress ?? 0}/${count} 段`;
  if (typeof count === "object") {
    const done = count.done ?? count.current ?? count.value;
    const total = count.total ?? count.max;
    if (done != null && total != null) return `已处理 ${done}/${total} 段`;
    if (done != null) return `已处理 ${done} 段`;
  }
  return "";
}

function jobElapsed(job) {
  const started = Date.parse(job?.startedAt ?? "");
  if (!Number.isFinite(started)) return "";
  const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

function handoverTextOf(handover) {
  if (handover?.handoverText) return String(handover.handoverText);
  const path = handover?.totalPath || handover?.path || "";
  return ["继续之前的工作。请先读取以下交接文档：", path, "读取后先告诉我当前进展、未完成事项和下一步建议。"].join("\n");
}

function sessionJob(sessionId) {
  if (!sessionId) return null;
  const cur = currentSession();
  if (cur?.sessionId === sessionId) return currentJob();
  const all = [...(UI.state?.sessions ?? []), ...(UI.state?.unarchived ?? [])];
  return all.find((item) => (item.sessionId || item.id) === sessionId)?.job ?? null;
}

function sessionPrepareBusy(sessionId) {
  const job = sessionJob(sessionId);
  return isRunningJob(job) && job.mode !== "scan";
}

function sessionArchiveBusy(sessionId) {
  return isRunningJob(sessionJob(sessionId));
}

/* ---------- 渲染：顶栏 / 横幅 / 当前会话 ---------- */

function render() {
  renderHeader();
  renderBanners();
  renderCurrent();
  renderJob();
  renderChoices();
  renderHistory();
  renderAdvanced();
  renderPrepare();
}

function renderHeader() {
  const st = UI.state ?? {};
  const cwd = st.boundCwd || st.cwd || BOUND_CWD || "";
  const label = $("cwdLabel");
  setText(label, cwd || "未绑定工作区");
  label.title = cwd;
  const title = currentSession()?.title;
  document.title = title ? `无痛切 · ${truncate(title, 24)}` : "无痛切 · 准备切换会话";
}

function renderBanners() {
  const st = UI.state ?? {};
  const items = [];

  if (UI.authBroken) {
    items.push({
      kind: "bad",
      icon: "triangle-alert",
      text: "面板令牌无效或已过期。请从 ZCode 里重新执行 /change 面板，或重新加载本页。",
      actions: [{ act: "reload", label: "重新加载" }],
    });
  } else if (UI.conn) {
    items.push({
      kind: "bad",
      icon: "triangle-alert",
      text: `刷新失败：${UI.conn.message}${UI.conn.status === 403 ? "（令牌无效）" : ""}`,
      actions: [{ act: "retry-conn", label: "重试" }],
    });
  }

  if (st.currentError) {
    const actions = [{ act: "retry-conn", label: "重试" }];
    if (UI.pinned) actions.push({ act: "use-auto", label: "切回自动选择" });
    if (OPEN_SESSION_ID) actions.push({ act: "use-open-session", label: "改用打开面板时的会话" });
    items.push({ kind: "bad", icon: "triangle-alert", text: `当前会话不可用：${st.currentError}`, actions });
  }

  if (st.liveError) {
    items.push({
      kind: "warn",
      icon: "info",
      text: `读取 ZCode 会话列表失败：${st.liveError}（历史列表可能不完整）`,
      actions: [],
    });
  }

  // 后台归档（scan）失败只写进日志和 job 文件，主面板按 design 不显示 scan 任务；
  // 这里用常驻横幅兜底，否则用户会一直以为"已归档 N 段"而最新压缩段其实没归档。
  const scanJob = st.current?.job;
  if (scanJob && scanJob.mode === "scan") {
    const scanActions = st.current?.sessionId ? [{ act: "archive", id: st.current.sessionId, label: "重新归档" }] : [];
    const firstError = (value) => String(value ?? "").split("\n")[0].slice(0, 200);
    if (scanJob.status === "error" || scanJob.status === "stale") {
      items.push({
        kind: "bad",
        icon: "triangle-alert",
        text: `后台归档失败：${firstError(scanJob.error) || "没有错误详情"}。归档不会自动重试，可点「重新归档」。`,
        actions: scanActions,
      });
    } else if (scanJob.status === "done" && (scanJob.fatal || (scanJob.errors ?? []).length > 0)) {
      const errors = scanJob.errors ?? [];
      const detail = firstError(errors[0]?.error);
      items.push({
        kind: "warn",
        icon: "info",
        text: scanJob.fatal
          ? `后台归档未成功：${detail || "压缩段没能写入归档"}。可点「重新归档」再试一次。`
          : `上次归档有 ${errors.length} 段没能写成摘要${detail ? `：${detail}` : ""}。交接文档会退回使用这些段的原文。`,
        actions: scanActions,
      });
    }
  }

  const providers = st.providers ?? [];
  if (st.config && !providers.some((p) => p.usable)) {
    items.push({
      kind: "warn",
      icon: "info",
      text: "没有可用的模型供应商，交接文档会生成失败。请先在 ZCode 里配置供应商，或到高级设置里选一个。",
      actions: [{ act: "open-advanced", label: "打开高级设置" }],
    });
  }

  const sig = JSON.stringify(items);
  if (sig === UI.sigs.banners) return;
  UI.sigs.banners = sig;

  const box = $("banners");
  clear(box);
  for (const item of items) {
    box.append(
      h(
        "div",
        { class: `banner ${item.kind}` },
        icon(item.icon),
        h("span", { class: "msg", text: item.text }),
        ...(item.actions ?? []).map((a) =>
          h("button", { type: "button", class: "btn small ghost", dataset: { act: a.act, ...(a.id ? { id: a.id } : {}) }, text: a.label }),
        ),
      ),
    );
  }
  refreshIcons(box);
}

function renderCurrent() {
  const cur = currentSession();
  const st = UI.state;

  const titleNode = $("currentTitle");
  titleNode.removeAttribute("aria-busy");
  if (!st) {
    setText(titleNode, "加载中…");
    setText($("currentMeta"), "");
    setText($("currentResolved"), "");
    return;
  }
  if (!cur) {
    setText(titleNode, st.currentError ? "没有可交接的会话" : "—");
    setText($("currentMeta"), st.currentError ? "先处理上面的提示，或刷新重试。" : "");
    setText($("currentResolved"), "");
    return;
  }

  setText(titleNode, cur.title || cur.sessionId || "未命名会话");
  const parts = [];
  if (cur.chunkCount != null) parts.push(`${cur.chunkCount} 段压缩摘要`);
  if (cur.updatedAt) parts.push(`最后活动 ${fmtTime(cur.updatedAt)}`);
  if (cur.handover?.builtAt) parts.push(`上次交接 ${fmtTime(cur.handover.builtAt)}`);
  setText($("currentMeta"), parts.join(" · "));

  const resolved = { "latest-updated": "已自动选择最近使用的会话", environment: "已自动选择当前会话" }[cur.resolvedBy] ?? (UI.pinned ? "已按你的选择" : "");
  setText($("currentResolved"), resolved);
}

function renderPrepare() {
  const view = jobView();
  const cur = currentSession();
  const btn = $("btnPrepare");
  const label = $("btnPrepareLabel");
  const hasSession = Boolean(cur?.sessionId);

  let text = "准备切换会话";
  let disabled = false;
  let hint = "正常工作时不用管，归档会自动完成。准备开新对话时点这里。";

  if (UI.authBroken) {
    disabled = true;
    hint = "面板令牌无效，先重新加载页面。";
  } else if (!hasSession) {
    disabled = true;
    hint = "当前工作区还没有可交接的会话。";
  } else if (view.kind === "running") {
    text = "正在准备…";
    disabled = true;
    hint = "页面可以关掉，任务会在后台继续。";
  } else if (view.kind === "success") {
    text = "重新准备交接";
    hint = "复制新会话提示后，粘贴到新会话继续。";
  } else if (view.kind === "error") {
    text = "重试准备交接";
    hint = "失败不会自动重试，可以点上面的按钮重来。";
  } else if (cur?.chunkCount === 0 && !cur?.handover) {
    hint = "还没有归档记录也没关系，可以直接准备交接。";
  } else {
    const job = view.job;
    if (job && (job.status === "queued" || job.status === "running") && job.mode === "scan") hint = "正在后台自动归档，不影响你继续工作。";
  }

  // POST 请求尚未返回时也要锁住入口；active scan 仍允许通过主按钮挂接 prepareRequested。
  disabled = disabled || UI.prepareBusy || isActiveJob(currentJob());
  setText(label, text);
  btn.disabled = disabled;
  btn.title = disabled && !hasSession ? "当前工作区还没有可交接的会话" : "";
  // 同一屏只保留一个主色按钮：成功态的「复制」和失败态的「重试」在状态面板里
  btn.classList.toggle("primary", view.kind === "idle" || view.kind === "running");
  setText($("prepareHint"), hint);

  const idle = view.kind === "idle" ? view : null;
  if (idle) {
    const job = idle.job;
    const scanning = job && (job.status === "queued" || job.status === "running") && job.mode === "scan";
    let idleText;
    if (!UI.state) idleText = "加载中…";
    else if (!cur) idleText = UI.state.currentError || "还没有可交接的会话。";
    else if (scanning) idleText = "正在后台自动归档当前对话，不影响你继续工作。";
    else if (cur.chunkCount > 0) idleText = `已归档 ${cur.chunkCount} 段压缩摘要，可以随时准备交接。`;
    else idleText = "准备交接时会一起整理历史记录和当前对话。";
    setText($("idleText"), idleText);
  }
}

/* ---------- 渲染：状态面板（全部原地更新，不重建 DOM） ---------- */

function renderJob() {
  const view = jobView();
  const views = { idle: $("jobIdle"), running: $("jobRunning"), success: $("jobSuccess"), error: $("jobError") };
  for (const [kind, node] of Object.entries(views)) node.hidden = kind !== view.kind;

  if (view.kind === "running") renderRunning(view);
  else if (view.kind === "success") renderSuccess(view);
  else if (view.kind === "error") renderError(view);

  if (UI.view !== view.kind) {
    if (view.kind === "success" && UI.view === "running") announce("交接已准备好，可以复制提示到新会话了。");
    if (view.kind === "error" && UI.view === "running") announce("交接准备失败，请查看错误信息后重试。");
    UI.view = view.kind;
  }
}

function renderRunning(view) {
  const job = view.job ?? {};
  const phase = PHASE_LABEL[job.phase] ?? (job.status === "queued" ? PHASE_LABEL.queued : "正在准备交接文档");
  const count = jobCountText(job);
  setText($("runPhase"), job.status === "queued" ? "已排队，马上开始" : phase);

  const pct = jobPercent(job);
  const bar = $("runBar");
  bar.classList.toggle("indeterminate", pct == null);
  if (pct != null) {
    bar.setAttribute("aria-valuenow", String(pct));
    $("runBarFill").style.width = `${pct}%`;
  } else {
    bar.removeAttribute("aria-valuenow");
    $("runBarFill").style.width = "";
  }

  const bits = [];
  if (count) bits.push(count);
  const elapsed = jobElapsed(job);
  if (elapsed) bits.push(`已用 ${elapsed}`);
  bits.push("页面可以关掉，任务会在后台继续。");
  setText($("runHint"), bits.filter(Boolean).join(" · "));

  const draft = view.draft;
  const draftBox = $("runDraftActions");
  draftBox.hidden = !draft;
  if (draft) {
    $("btnRunDraftCopy").dataset.text = handoverTextOf(draft);
    setText($("runDraftText"), "这是可立即复制的未精炼草稿，后台完成后会自动替换为最终版。");
  } else {
    $("btnRunDraftCopy").dataset.text = "";
    setText($("runDraftText"), "");
  }

  const prev = view.handover;
  const prevBox = $("runPrevActions");
  prevBox.hidden = !prev?.builtAt;
  if (prev?.builtAt) {
    setText($("runPrevText"), `上一版最终交接生成于 ${fmtTime(prev.builtAt)}，可先查看。`);
  }
}

function renderSuccess(view) {
  const handover = view.handover ?? {};
  const cur = currentSession();

  const meta = [];
  if (handover.builtAt) meta.push(`生成于 ${fmtTime(handover.builtAt)}`);
  if (handover.chunkCount != null) meta.push(`共 ${handover.chunkCount} 段`);
  if (handover.liveIncluded === true) meta.push("已包含当前未压缩内容");
  else if (handover.liveIncluded === false) meta.push("未包含未压缩内容");
  if (handover.model) meta.push(handover.model);
  setText($("succMeta"), meta.join(" · "));

  const stale = Boolean(cur?.stale);
  $("succStale").hidden = !stale;
  if (stale) setText($("succStale"), "这份交接生成后，当前对话又有新消息了。内容可能已经落后，建议点上面的「重新准备交接」再生成一次。");

  const path = handover.totalPath || handover.path || "";
  setText($("succPath"), path ? `交接文档：${path}` : "交接文档已写入归档目录。");
  $("succPath").title = path;

  const highlights = handover.highlights ?? {};
  const fields = [
    ["overview", $("hlOverview")],
    ["conclusions", $("hlConclusions")],
    ["constraints", $("hlConstraints")],
  ];
  let any = false;
  for (const [key, node] of fields) {
    const value = String(highlights[key] ?? "").trim();
    any = any || Boolean(value);
    setText(node, value || "（这一节没有内容）");
    node.hidden = false;
  }
  $("hlEmpty").hidden = any;

  const warnings = (handover.warnings ?? []).filter(Boolean);
  const warnBox = $("succWarnings");
  warnBox.hidden = warnings.length === 0;
  if (warnings.length) setText(warnBox, `注意：\n${warnings.map((w) => `· ${w}`).join("\n")}`);

  const copyText = handoverTextOf(handover);
  $("succTitle").textContent = handover.isFallback ? "交接已生成（机械版）" : "交接已准备好";
  $("btnCopy").dataset.text = copyText;
  $("btnPrevCopy").dataset.text = copyText;

  $("btnOpenDir").hidden = !cur?.dir;
  $("btnOpenDir").dataset.path = cur?.dir ?? "";
}

function renderError(view) {
  setText($("errText"), view.message || "未知错误");
  const draft = view.draft;
  const prev = view.handover;
  const source = draft ?? prev;
  const box = $("prevHandover");
  box.hidden = !source;
  if (source) {
    setText($("prevHandoverText"), draft
      ? "模型任务失败，但可复制的机械草稿仍然保留；可以先继续工作，之后再重试。"
      : `上一次的交接文档生成于 ${fmtTime(prev.builtAt)}，早于本次失败，内容可能已经过期。`);
    $("btnPrevCopy").dataset.text = handoverTextOf(source);
    setText($("btnPrevCopy"), draft ? "复制当前草稿" : "复制旧提示");
    $("btnPrevView").hidden = !prev;
  } else {
    $("btnPrevCopy").dataset.text = "";
    $("btnPrevView").hidden = true;
  }
}

/* ---------- 渲染：会话选择 / 历史归档 / 高级 ---------- */

function pinActive() {
  return Boolean(UI.pinned);
}

function renderChoices() {
  const st = UI.state;
  if (!st) return;
  const choices = st.choices ?? [];
  const cur = st.current;
  const sig = JSON.stringify([choices.map((c) => [c.sessionId, c.title, c.updatedAt]), UI.pinned, cur?.sessionId, cur?.title, cur?.resolvedBy]);
  if (sig === UI.sigs.choices) return;
  UI.sigs.choices = sig;

  const box = $("choicesList");
  clear(box);

  const rows = [];
  rows.push(
    choiceRow("", "自动（最近活动的会话）", pinActive() ? "点一下切回自动选择" : "当前生效", !pinActive(), cur?.resolvedBy === "latest-updated" ? "已自动选择最近使用的会话" : ""),
  );
  for (const c of choices) {
    if (!c?.sessionId) continue;
    const isCurrent = c.sessionId === cur?.sessionId;
    rows.push(choiceRow(c.sessionId, c.title || c.sessionId, `${fmtTime(c.updatedAt)}${isCurrent ? " · 当前会话" : ""}`, pinActive() && UI.pinned === c.sessionId, ""));
  }
  if (pinActive() && cur && !choices.some((c) => c.sessionId === UI.pinned)) {
    rows.push(choiceRow(UI.pinned, cur.title || UI.pinned, "手动选择 · 当前会话", true, ""));
  }
  for (const row of rows) box.append(row);

  setText($("choicesCount"), choices.length ? `${choices.length} 个可选` : "没有其它会话");
}

function choiceRow(id, title, meta, checked, note) {
  const input = h("input", { type: "radio", name: "wtq-session", value: id, "aria-label": title });
  input.checked = Boolean(checked);
  input.addEventListener("change", () => {
    if (!input.checked) return;
    selectSession(id);
  });
  return h(
    "label",
    { class: `choice${checked ? " picked" : ""}` },
    input,
    h(
      "div",
      { class: "choice-main" },
      h("p", { class: "choice-title", text: title }, note ? h("span", { class: "badge now", text: note }) : null),
      meta ? h("p", { class: "choice-meta", text: meta }) : null,
    ),
  );
}

function renderHistory() {
  const st = UI.state;
  if (!st) return;
  const sessions = st.sessions ?? [];
  const unarchived = st.unarchived ?? [];
  const cur = st.current;
  const sig = JSON.stringify([
    sessions.map((s) => [s.slug, s.title, s.chunkCount, s.total?.mtime, s.live?.mtime, s.updatedAt, s.running, s.sessionId, s.job?.jobId, s.job?.status, s.job?.mode]),
    unarchived.map((u) => [u.id, u.pendingCompactions, u.updatedAt, u.running, u.job?.jobId, u.job?.status, u.job?.mode]),
    cur?.slug,
    UI.prepareBusy,
  ]);
  if (sig === UI.sigs.history) return;
  UI.sigs.history = sig;

  setText($("historyCount"), sessions.length ? `${sessions.length} 个会话` : "还没有归档");

  const box = $("sessionsList");
  clear(box);
  if (!sessions.length) {
    box.append(h("p", { class: "empty", text: "还没有归档。发生一次上下文压缩后，这里会自动多出一段。" }));
  } else {
    for (const s of sessions) box.append(archivedRow(s, cur));
  }

  const upBox = $("unarchivedBox");
  upBox.hidden = unarchived.length === 0;
  const upList = $("unarchivedList");
  clear(upList);
  for (const u of unarchived) upList.append(unarchivedRow(u));
}

function archivedRow(session, cur) {
  const isCurrent = session.slug && cur?.slug && session.slug === cur.slug;
  const busy = sessionPrepareBusy(session.sessionId);
  const meta = [];
  meta.push(`${session.chunkCount ?? 0} 段`);
  if (session.updatedAt) meta.push(`更新于 ${fmtTime(session.updatedAt)}`);
  if (session.total?.mtime) meta.push(`交接文档 ${fmtTime(session.total.mtime)}`);

  const chips = [];
  for (const chunk of session.chunks ?? []) {
    if (!chunk?.file) continue;
    chips.push(
      h("button", { type: "button", class: "chip", title: `预览 ${chunk.file}`, dataset: { act: "view", slug: session.slug, file: chunk.file }, text: chunk.file.replace(/\.md$/, "") }),
    );
  }
  if (session.live) chips.push(h("button", { type: "button", class: "chip live", title: "预览当前未压缩内容", dataset: { act: "view", slug: session.slug, file: "LIVE.md" }, text: "当前未压缩内容" }));
  if (session.total) chips.push(h("button", { type: "button", class: "chip total", title: "预览交接文档", dataset: { act: "view", slug: session.slug, file: "TOTAL.md" }, text: "交接文档" }));

  const actions = [];
  if (session.sessionId) actions.push(h("button", {
    type: "button",
    class: "btn small",
    disabled: busy || UI.prepareBusy,
    title: busy ? "该会话已有后台任务" : "",
    dataset: { act: "prepare", id: session.sessionId, label: "准备交接" },
    text: busy ? "处理中…" : "准备交接",
  }));
  actions.push(h("button", { type: "button", class: "btn small ghost", dataset: { act: "folder", slug: session.slug, label: "打开目录" }, text: "打开目录" }));

  return h(
    "div",
    { class: "row" },
    h(
      "div",
      { class: "row-main" },
      h("p", { class: "row-title", text: session.title || session.slug || "未命名会话" }, isCurrent ? h("span", { class: "badge now", text: "当前" }) : null, session.running ? h("span", { class: "badge run", text: "归档中" }) : null),
      h("p", { class: "row-meta", text: meta.join(" · ") }),
      chips.length ? h("div", { class: "chips" }, ...chips) : null,
    ),
    h("div", { class: "row-actions" }, ...actions),
  );
}

function unarchivedRow(session) {
  const sessionId = session.sessionId || session.id;
  const prepareBusy = sessionPrepareBusy(sessionId);
  const archiveBusy = sessionArchiveBusy(sessionId);
  const busy = prepareBusy || archiveBusy;
  const meta = [`${session.pendingCompactions ?? 0} 个压缩边界待归档`];
  if (session.updatedAt) meta.push(`更新于 ${fmtTime(session.updatedAt)}`);
  return h(
    "div",
    { class: "row" },
    h(
      "div",
      { class: "row-main" },
      h("p", { class: "row-title", text: session.title || session.id || "未命名会话" }, session.running ? h("span", { class: "badge run", text: "归档中" }) : null),
      h("p", { class: "row-meta", text: meta.join(" · ") }),
    ),
    h(
      "div",
      { class: "row-actions" },
      h("button", {
        type: "button",
        class: "btn small",
        disabled: prepareBusy || UI.prepareBusy,
        title: prepareBusy ? "该会话已有交接任务" : "",
        dataset: { act: "prepare", id: sessionId, label: "准备交接" },
        text: prepareBusy ? "处理中…" : "准备交接",
      }),
      h("button", {
        type: "button",
        class: "btn small ghost",
        disabled: archiveBusy || UI.prepareBusy,
        title: archiveBusy ? "该会话已有后台任务" : "",
        dataset: { act: "archive", id: sessionId, label: "立即归档" },
        text: archiveBusy ? "处理中…" : "立即归档",
      }),
    ),
  );
}

function renderAdvanced() {
  const st = UI.state;
  if (!st) return;
  const open = $("foldAdvanced").open;
  if (!open) return;

  const root = st.root || "";
  setText($("rootPath"), root || "（归档目录还没确定）");
  $("rootPath").title = root;

  mountSettings();
  renderProviders();
  renderLog();
}

/* ---------- 高级：设置表单（只在打开时挂载 / 同步，轮询不重建） ---------- */

function mountSettings() {
  const st = UI.state;
  if (!st) return;
  if (!UI.settings.mounted) {
    UI.settings.mounted = true;
    const form = $("settingsForm");
    clear(form);
    for (const field of SETTINGS_FIELDS) form.append(buildField(field));
  }
  syncSettings();
}

function buildField(field) {
  const box = h("div", { class: "field" });
  let control;
  if (field.type === "bool") {
    control = h("input", { type: "checkbox", id: `set-${field.key}`, dataset: { key: field.key, type: "bool" } });
    box.append(h("label", { class: "switch", for: `set-${field.key}` }, control, h("span", { text: field.label })));
  } else if (field.type === "provider") {
    control = h("select", { id: `set-${field.key}`, dataset: { key: field.key, type: "text" } });
    box.append(h("label", { for: `set-${field.key}`, text: field.label }), control);
  } else if (field.type === "number") {
    control = h("input", { type: "number", min: field.min ?? "1000", step: field.step ?? "1000", id: `set-${field.key}`, inputmode: "numeric", dataset: { key: field.key, type: "number" } });
    box.append(h("label", { for: `set-${field.key}`, text: field.label }), control);
  } else {
    control = h("input", { type: "text", id: `set-${field.key}`, dataset: { key: field.key, type: "text" } });
    box.append(h("label", { for: `set-${field.key}`, text: field.label }), control);
  }
  box.append(h("p", { class: "desc", text: field.desc }));
  control.addEventListener("change", () => saveSetting(field, control));
  UI.settings.ctl[field.key] = { field, control };
  return box;
}

function syncSettings() {
  const st = UI.state;
  if (!st || !UI.settings.mounted) return;
  if (UI.settings.dirty || UI.settings.saving) return;
  if ($("settingsForm").contains(document.activeElement)) return; // 正在输入就别动它

  const cfg = st.config ?? {};
  const cfgSig = JSON.stringify(cfg);
  if (cfgSig === UI.settings.cfgSig) return;
  UI.settings.cfgSig = cfgSig;

  for (const { field, control } of Object.values(UI.settings.ctl)) {
    const value = cfg[field.key];
    if (field.type === "bool") {
      const next = Boolean(value);
      if (control.checked !== next) control.checked = next;
    } else if (field.type === "provider") {
      syncProviderOptions(control, value);
    } else {
      const next = value == null ? "" : String(value);
      if (control.value !== next) control.value = next;
    }
  }
}

function syncProviderOptions(select, selected) {
  const provs = (UI.state?.providers ?? []).filter((p) => p.usable);
  const sig = JSON.stringify(provs.map((p) => [p.providerId, p.name, p.models]));
  if (sig !== UI.settings.provSig) {
    UI.settings.provSig = sig;
    clear(select);
    select.append(h("option", { value: "", text: "自动挑选（推荐）" }));
    for (const p of provs) select.append(h("option", { value: p.providerId, text: `${p.name} — ${(p.models ?? []).join(", ")}` }));
  }
  const next = selected ?? "";
  if (select.value !== next) select.value = next;
}

async function saveSetting(field, control) {
  let value;
  if (field.type === "bool") value = control.checked;
  else if (field.type === "number") {
    const n = Number(control.value);
    if (!control.value.trim() || !Number.isFinite(n)) {
      setSettingsStatus(`「${field.label}」需要填数字`, "bad");
      return;
    }
    if (field.key === "summaryContextTokens" || field.key === "summaryOutputTokens") {
      if (!Number.isSafeInteger(n) || n < 1) {
        setSettingsStatus(`「${field.label}」需要填正整数`, "bad");
        return;
      }
      const context = field.key === "summaryContextTokens" ? n : Number(UI.state?.config?.summaryContextTokens ?? 65536);
      const output = field.key === "summaryOutputTokens" ? n : Number(UI.state?.config?.summaryOutputTokens ?? 8192);
      if (context <= output + 1536) {
        setSettingsStatus("上下文预算必须大于输出预算 + 1536 tokens，未保存。", "bad");
        return;
      }
    }
    value = n;
  } else value = control.value;

  UI.settings.dirty = true;
  UI.settings.saving = true;
  setSettingsStatus("正在保存…");
  try {
    const res = await api("/api/config", { method: "POST", body: JSON.stringify({ patch: { [field.key]: value } }) });
    if (res.config && UI.state) UI.state.config = res.config;
    UI.settings.dirty = false;
    UI.settings.cfgSig = "";
    setSettingsStatus(`已保存（${fmtTime(new Date().toISOString())}）`, "ok");
    refresh({ silent: true });
  } catch (err) {
    setSettingsStatus(`保存失败：${err.message}`, "bad");
  } finally {
    UI.settings.saving = false;
  }
}

function setSettingsStatus(message, kind = "") {
  const node = $("settingsStatus");
  node.className = `save-msg ${kind}`;
  setText(node, message);
}

function renderProviders() {
  const provs = UI.state?.providers ?? [];
  const sig = JSON.stringify(provs);
  if (sig === UI.sigs.prov) return;
  UI.sigs.prov = sig;

  const box = $("providerList");
  clear(box);
  if (!provs.length) {
    box.append(h("p", { class: "empty", text: "没有读到供应商配置。先确认 ZCode 里已经配好模型。" }));
    return;
  }
  for (const p of provs) {
    box.append(
      h(
        "div",
        { class: "prov" },
        h("span", { class: p.usable ? "ok" : "no", text: p.usable ? "可用" : "不可用" }),
        h("b", { text: p.name ?? p.providerId }),
        h("span", { class: "mono", text: p.baseUrl ?? "" }),
        h("span", { class: "mono", text: (p.models ?? []).join(", ") }),
        p.enabled === false ? h("span", { class: "badge", text: "已禁用" }) : null,
        p.hasKey === false ? h("span", { class: "badge", text: "没有密钥" }) : null,
      ),
    );
  }
}

function compactLog(entry) {
  if (entry.event === "chunk") return `#${entry.index} ${entry.file ?? ""} ${entry.rows ?? "?"}行 ${entry.toolCalls ?? "?"}次工具 摘要=${entry.summarized ? "是" : "否"} ${entry.model ?? ""}`;
  if (entry.event === "total") return `${entry.chunks ?? "?"} 段 / ${entry.passes ?? "?"} 轮 token=${entry.usage?.totalTokens ?? "?"}`;
  if (entry.event === "panel-start") return `端口 ${entry.port} pid ${entry.pid}`;
  const rest = { ...entry };
  delete rest.event;
  delete rest.at;
  return Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${truncate(typeof v === "object" ? JSON.stringify(v) : v, 60)}`)
    .join(" ");
}

function renderLog() {
  const entries = (UI.state?.log ?? []).slice(-40).reverse();
  const sig = JSON.stringify(entries);
  if (sig === UI.sigs.log) return;
  UI.sigs.log = sig;

  const box = $("log");
  clear(box);
  if (!entries.length) {
    box.append(h("p", { class: "empty", text: "还没有日志。" }));
    return;
  }
  for (const entry of entries) {
    box.append(h("div", {}, h("span", { class: "ev", text: String(entry.event ?? "?") }), ` ${String(entry.at ?? "").slice(11, 19)} ${compactLog(entry)}`));
  }
}

/* ---------- 动作 ---------- */

async function prepareSwitch(sessionId) {
  if (UI.authBroken) {
    toast("面板令牌无效，先重新加载页面", "bad");
    return;
  }
  if (UI.prepareBusy || isActiveJob(currentJob())) return;
  UI.prepareBusy = true;
  UI.localError = null;
  const id = sessionId || currentSession()?.sessionId || UI.pinned || "";
  UI.optimistic = { job: { status: "queued", mode: "prepare-switch", phase: "queued", startedAt: new Date().toISOString() }, at: Date.now(), until: Date.now() + 90000 };
  renderJob();
  renderPrepare();

  try {
    const res = await api("/api/prepare-switch", {
      method: "POST",
      body: JSON.stringify({ sessionId: id || undefined, cwd: BOUND_CWD }),
      timeoutMs: 20000,
    });
    if (res && res.ok === false) throw new ApiError(res.error || "准备交接失败", 0);
    const cur = currentSession();
    if (UI.state?.current && (!id || cur?.sessionId === id)) {
      const nextCurrent = { ...UI.state.current };
      if (res?.job) nextCurrent.job = res.job;
      if (res?.draft) nextCurrent.draft = res.draft;
      if (res?.handover) nextCurrent.handover = res.handover;
      else if (res?.status === "cached") nextCurrent.handover = res;
      UI.state.current = nextCurrent;
    }
    if (res?.job && isActiveJob(res.job)) UI.optimistic = { job: res.job, at: Date.now(), until: Date.now() + 90000 };
    else UI.optimistic = null;
    toast(res?.status === "cached" ? "已复用最新交接，可直接复制。" : res?.existing ? "已并入后台任务，可先复制当前草稿。" : "已生成草稿，后台继续完善最终交接。", "ok");
    renderJob();
    renderPrepare();
    schedulePoll(300);
  } catch (err) {
    UI.optimistic = null;
    UI.localError = { message: err.message, at: Date.now() };
    if (err.status === 403) {
      UI.authBroken = true;
      clearTimeout(UI.pollTimer);
    }
    renderBanners();
    renderJob();
    renderPrepare();
  } finally {
    UI.prepareBusy = false;
    renderPrepare();
  }
}

async function selectSession(sessionId) {
  UI.pinned = sessionId || "";
  resetSessionScopedState();
  try {
    if (UI.pinned) localStorage.setItem(PIN_KEY, UI.pinned);
    else localStorage.removeItem(PIN_KEY);
  } catch {
    /* 忽略 */
  }
  try {
    const url = new URL(location.href);
    if (UI.pinned) url.searchParams.set("sessionId", UI.pinned);
    else url.searchParams.delete("sessionId");
    history.replaceState(null, "", url.pathname + (url.search || ""));
  } catch {
    /* 忽略 */
  }
  await refresh({ silent: true });
}

async function archiveNow(sessionId, btn) {
  if (!sessionId || sessionArchiveBusy(sessionId) || UI.prepareBusy) return;
  const original = btn.dataset.label || "立即归档";
  btn.disabled = true;
  btn.textContent = "归档中…";
  try {
    const res = await api("/api/archive", { method: "POST", body: JSON.stringify({ sessionId, cwd: BOUND_CWD }), timeoutMs: 20000 });
    if (res && res.ok === false) throw new ApiError(res.error || "归档失败", 0);
    toast(res?.job ? (res.existing ? "已并入正在运行的后台归档任务。" : "已启动后台归档，进度会自动更新。") : res?.newCount ? `已归档 ${res.newCount} 段` : "没有新的压缩需要归档", "ok");
    await refresh({ silent: true });
  } catch (err) {
    toast(`归档失败：${err.message}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function openFolder(path) {
  if (!path) {
    toast("没有可打开的目录", "bad");
    return;
  }
  try {
    const res = await api("/api/open-folder", { method: "POST", body: JSON.stringify({ path }) });
    if (res && res.ok === false) throw new ApiError(res.error || "打开失败", 0);
  } catch (err) {
    toast(`打开目录失败：${err.message}`, "bad");
  }
}

async function openFolderBySlug(slug) {
  if (!slug) return;
  try {
    const detail = await api(`/api/session?slug=${encodeURIComponent(slug)}`);
    if (detail?.error) throw new ApiError(detail.error, 0);
    await openFolder(detail.dir);
  } catch (err) {
    toast(`打开目录失败：${err.message}`, "bad");
  }
}

/* ---------- 文档对话框 ---------- */

function showDialog(dialog) {
  UI.lastFocus = document.activeElement;
  try {
    dialog.showModal();
  } catch {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog) {
  try {
    dialog.close();
  } catch {
    dialog.removeAttribute("open");
  }
  if (UI.lastFocus?.focus) UI.lastFocus.focus();
  UI.lastFocus = null;
}

async function openDoc(slug, file, title, dir) {
  const cur = currentSession();
  const fallbackDir = slug && cur?.slug && slug === cur.slug ? cur.dir ?? "" : "";
  UI.doc = { slug, file, title: title || file, dir: dir || fallbackDir };
  UI.docSeq += 1; // 作废上一次还没回来的预览请求
  const dialog = $("docDialog");
  setText($("docTitle"), UI.doc.title);
  setText($("docBody"), "");
  $("docOpenFolder").hidden = !UI.doc.dir;
  $("docOpenFolder").dataset.path = UI.doc.dir;
  showDocStatus("加载中…");
  $("docRetry").hidden = true;
  showDialog(dialog);
  await loadDoc();
}

function showDocStatus(message) {
  const node = $("docStatus");
  node.hidden = !message;
  setText(node, message ?? "");
}

async function loadDoc() {
  const doc = UI.doc;
  if (!doc) return;
  const seq = ++UI.docSeq; // 本次请求的代号；期间切了文档或关了对话框就作废
  showDocStatus("加载中…");
  $("docRetry").hidden = true;
  const stale = () => seq !== UI.docSeq || UI.doc !== doc;
  try {
    const res = await api(`/api/chunk?slug=${encodeURIComponent(doc.slug)}&file=${encodeURIComponent(doc.file)}`);
    if (stale()) return;
    setText($("docBody"), res.markdown ?? "");
    showDocStatus("");
  } catch (err) {
    if (stale()) return;
    setText($("docBody"), "");
    showDocStatus(`加载失败：${err.message}`);
    $("docRetry").hidden = false;
  }
}

/* ---------- 复制新会话提示 ---------- */

function setCopyMessage(message, kind = "") {
  const node = $("copyMsg");
  node.className = `copy-msg ${kind}`;
  setText(node, message);
}

async function copyText(text) {
  $("copyFallback").hidden = true;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("浏览器不支持自动复制");
    await navigator.clipboard.writeText(text);
    setCopyMessage("已复制。到新会话里直接粘贴即可。", "ok");
    announce("提示已复制到剪贴板。");
  } catch {
    const box = $("copyFallback");
    box.hidden = false;
    $("copyText").value = text;
    setCopyMessage("自动复制被浏览器拦下了，请用下面的文本框手动复制。", "warn");
    $("copyText").focus();
    $("copyText").select();
  }
}

async function copyFromData(btn) {
  const text = btn.dataset.text || "";
  if (!text) {
    toast("没有可复制的内容", "bad");
    return;
  }
  await copyText(text);
}

/* ---------- 确认对话框 ---------- */

function askConfirm(title, body, okLabel) {
  setText($("confirmTitle"), title);
  setText($("confirmBody"), body);
  setText($("confirmOk"), okLabel || "确定");
  const dialog = $("confirmDialog");
  showDialog(dialog);
  return new Promise((resolve) => {
    UI.confirmResolve = resolve;
  });
}

function settleConfirm(value) {
  if (!UI.confirmResolve) return;
  const resolve = UI.confirmResolve;
  UI.confirmResolve = null;
  resolve(value);
}

/* ---------- 事件绑定 ---------- */

document.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-act]");
  if (btn) {
    const { act, id, slug, path } = btn.dataset;
    if (act === "prepare") {
      if (id && id !== currentSession()?.sessionId) await selectSession(id);
      prepareSwitch(id);
      return;
    }
    if (act === "folder") return void openFolderBySlug(slug);
    if (act === "archive") return void archiveNow(id, btn);
    if (act === "view") return void openDoc(slug, btn.dataset.file, btn.title || btn.dataset.file, "");
    if (act === "retry-conn") return void refresh({ silent: true });
    if (act === "reload") return void location.reload();
    if (act === "open-advanced") {
      $("foldAdvanced").open = true;
      renderAdvanced();
      $("foldAdvanced").scrollIntoView({ block: "start" });
      return;
    }
    if (act === "use-open-session") {
      await selectSession(OPEN_SESSION_ID);
      return;
    }
    if (act === "use-auto") {
      await selectSession("");
      return;
    }
    if (act === "root-folder") return void openFolder(UI.state?.root);
  }
});

/* 顶栏 */
$("btnRefresh").addEventListener("click", async () => {
  await refresh({ silent: true });
  toast("已刷新", "ok");
});
$("btnSettings").addEventListener("click", () => {
  $("foldAdvanced").open = true;
  renderAdvanced();
  $("foldAdvanced").scrollIntoView({ block: "start" });
  $("foldAdvanced").querySelector("summary")?.focus();
});
$("btnShutdown").addEventListener("click", async () => {
  const ok = await askConfirm("关闭面板", "关闭面板进程？归档功能不受影响，下次打开会自动重启。", "关闭面板");
  if (!ok) return;
  try {
    await api("/api/shutdown", { method: "POST" });
    UI.stopped = true;
    clearTimeout(UI.pollTimer);
    document.body.replaceChildren(h("p", { class: "hint", style: "padding:40px", text: "面板已关闭，归档功能不受影响。这个标签页可以关掉了。" }));
  } catch (err) {
    toast(`关闭失败：${err.message}`, "bad");
  }
});

/* 主按钮 / 状态面板按钮 */
$("btnPrepare").addEventListener("click", () => prepareSwitch(currentSession()?.sessionId));
$("btnRetry").addEventListener("click", () => prepareSwitch(currentSession()?.sessionId));
$("btnCopy").addEventListener("click", (e) => copyFromData(e.currentTarget));
$("btnRunDraftCopy").addEventListener("click", (e) => copyFromData(e.currentTarget));
$("btnPrevCopy").addEventListener("click", (e) => copyFromData(e.currentTarget));
$("btnSelectCopy").addEventListener("click", async () => {
  const area = $("copyText");
  area.focus();
  area.select();
  try {
    const ok = document.execCommand && document.execCommand("copy");
    setCopyMessage(ok ? "已复制。" : "选中了，请按 Ctrl+C 复制。", ok ? "ok" : "warn");
  } catch {
    setCopyMessage("选中了，请按 Ctrl+C 复制。", "warn");
  }
});
$("btnViewTotal").addEventListener("click", () => {
  const cur = currentSession();
  if (!cur?.slug) return void toast("还没有交接文档", "bad");
  openDoc(cur.slug, "TOTAL.md", `交接文档 · ${truncate(cur.title || "", 30)}`, cur.dir);
});
$("btnPrevView").addEventListener("click", () => {
  const cur = currentSession();
  if (!cur?.slug) return void toast("还没有交接文档", "bad");
  openDoc(cur.slug, "TOTAL.md", `交接文档 · ${truncate(cur.title || "", 30)}`, cur.dir);
});
$("btnRunPrevView").addEventListener("click", () => {
  const cur = currentSession();
  if (!cur?.slug) return;
  openDoc(cur.slug, "TOTAL.md", `交接文档 · ${truncate(cur.title || "", 30)}`, cur.dir);
});
$("btnOpenDir").addEventListener("click", (e) => openFolder(e.currentTarget.dataset.path));

/* 文档对话框 */
$("docClose").addEventListener("click", () => closeDialog($("docDialog")));
$("docDone").addEventListener("click", () => closeDialog($("docDialog")));
$("docRetry").addEventListener("click", () => loadDoc());
$("docOpenFolder").addEventListener("click", (e) => openFolder(e.currentTarget.dataset.path));
$("docDialog").addEventListener("close", () => {
  UI.docSeq += 1; // 关掉之后到达的响应不再写回对话框
  showDocStatus("");
  UI.doc = null;
});

/* 确认对话框 */
$("confirmCancel").addEventListener("click", () => {
  closeDialog($("confirmDialog"));
  settleConfirm(false);
});
$("confirmOk").addEventListener("click", () => {
  closeDialog($("confirmDialog"));
  settleConfirm(true);
});
$("confirmDialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog($("confirmDialog"));
  settleConfirm(false);
});

/* 折叠区：记住开合状态，打开高级设置时才渲染里面的内容 */
for (const fold of document.querySelectorAll("details.fold")) {
  const key = fold.dataset.store;
  if (key) {
    try {
      if (localStorage.getItem(key) === "1") fold.open = true;
    } catch {
      /* 忽略 */
    }
  }
  fold.addEventListener("toggle", () => {
    if (key) {
      try {
        localStorage.setItem(key, fold.open ? "1" : "0");
      } catch {
        /* 忽略 */
      }
    }
    renderAdvanced();
  });
}

/* 回到页面时立刻刷新一次 */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh({ silent: true });
});

/* ---------- 启动 ---------- */

$("copyText").addEventListener("focus", (e) => e.currentTarget.select());

if (!window.lucide) document.documentElement.classList.add("no-icons");
refreshIcons(document);

renderPrepare();
refresh({ silent: true });
