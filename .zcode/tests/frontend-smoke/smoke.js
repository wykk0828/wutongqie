/* 无痛切面板前端 smoke test（jsdom）
   运行：在本目录执行 `node smoke.js`（依赖已随目录提供，无需联网安装）
   被测文件：plugins/wutongqie/web/{index.html,app.js,style.css,lucide.min.js}
   不启动浏览器、不写任何文件、不改动被测代码。

   约定：
   - index.html 的注入占位符是裸 JSON 形式 `window.__WTQ_SESSION_ID = __WTQ_SESSION_ID__;`，
     真实后端用 JSON 替换（无会话时是 ""）。本测试按同样方式替换：
     有会话 -> JSON.stringify("sess_xxx")，无会话 -> JSON.stringify("")。
   - 每个 DOM 都装错误收集器：jsdomError / console.error / window.onerror / unhandledrejection
     一律算测试失败；唯一例外是"lucide 文件缺失"的那一个用例（显式白名单）。 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

// 从本文件位置定位仓库根：<project>/.zcode/tests/frontend-smoke/smoke.js
const WEB = path.resolve(__dirname, "..", "..", "..", "plugins", "wutongqie", "web");
if (!fs.existsSync(path.join(WEB, "app.js"))) {
  console.error(`找不到待测前端目录：${WEB}`);
  process.exit(1);
}
console.log(`被测前端目录：${WEB}\n`);
const read = (f) => fs.readFileSync(path.join(WEB, f), "utf8");

const failures = [];
const passes = [];
function ok(cond, msg) {
  if (cond) passes.push(msg);
  else failures.push(msg);
}
const eq = (a, b, msg) => ok(String(a) === String(b), `${msg} (got: ${JSON.stringify(a)}, want: ${JSON.stringify(b)})`);
const has = (a, needle, msg) => ok(String(a).includes(needle), `${msg} (got: ${JSON.stringify(a)})`);

/** 意外 JS 错误收集器：白名单以外一律计入失败 */
function createErrorGuard(allow = []) {
  const lines = [];
  return {
    add(kind, text) {
      const line = `${kind}: ${String(text)}`;
      if (allow.some((re) => re.test(line))) return;
      lines.push(line);
    },
    get lines() {
      return lines.slice();
    },
    assertClean(label) {
      ok(lines.length === 0, `${label}：没有意外的 JS 错误${lines.length ? " -> " + lines.join(" | ") : ""}`);
    },
  };
}

const now = () => new Date().toISOString();
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function makeDraft(over = {}) {
  return {
    path: "E:\\proj\\.无痛切\\sessions\\s1-abc\\TOTAL.md",
    totalPath: "E:\\proj\\.无痛切\\sessions\\s1-abc\\TOTAL.md",
    builtAt: now(),
    sessionTitle: "测试会话",
    liveIncluded: true,
    warnings: ["这是未精炼草稿，后台完成后会自动替换为最终版。"],
    handoverText: "继续之前的工作。请先读取以下交接文档：\nE:\\proj\\.无痛切\\sessions\\s1-abc\\TOTAL.md\n读取后先告诉我当前进展、未完成事项和下一步建议。",
    highlights: { overview: "机械草稿", conclusions: "后台继续完善", constraints: "先读取 TOTAL.md" },
    chunkCount: 3,
    passes: 0,
    usage: { totalTokens: 0, calls: 0 },
    model: null,
    isDraft: true,
    isFallback: false,
    ...over,
  };
}

function makeHandover(over = {}) {
  return {
    path: "E:\\proj\\.无痛切\\sessions\\s1-abc\\TOTAL.md",
    totalPath: "E:\\proj\\.无痛切\\sessions\\s1-abc\\TOTAL.md",
    builtAt: now(),
    sessionTitle: "测试会话",
    liveIncluded: true,
    warnings: ["LIVE 段摘要使用了旧模型"],
    handoverText: "继续之前的工作。请先读取以下交接文档：\nE:\\proj\\TOTAL.md\n读取后先告诉我当前进展、未完成事项和下一步建议。",
    highlights: { overview: "在做无痛切面板", conclusions: "1. 前端已重写", constraints: "不要用蓝色" },
    chunkCount: 3,
    passes: 2,
    usage: { totalTokens: 1234 },
    model: "p1/m1",
    ...over,
  };
}

function makeState(over = {}) {
  const session = {
    slug: "s1-abc",
    sessionId: "sess_test1",
    title: "测试会话",
    chunkCount: 2,
    chunks: [{ file: "01-x.md", size: 10, mtime: now() }],
    live: { file: "LIVE.md", size: 5, mtime: now() },
    total: { file: "TOTAL.md", size: 20, mtime: now() },
    updatedAt: now(),
    running: false,
  };
  return {
    cwd: "E:\\proj",
    boundCwd: "E:\\proj",
    root: "E:\\proj\\.无痛切",
    config: {
      llmProviderId: "",
      llmModelId: "",
      outputRoot: "",
      saveRaw: true,
      announce: false,
      maxTranscriptChars: 180000,
      mergeBudgetChars: 60000,
      summaryContextTokens: 65536,
      summaryOutputTokens: 8192,
      skipLiveForTotal: false,
    },
    providers: [{ providerId: "p1", name: "P1", apiType: "openai-chat-completions", baseUrl: "https://x", hasKey: true, usable: true, enabled: true, models: ["m1"] }],
    log: [{ at: now(), event: "chunk", index: 1, file: "01-x.md", rows: 10, toolCalls: 2, summarized: true, model: "p1/m1" }],
    sessions: [session],
    unarchived: [],
    choices: [
      { sessionId: "sess_test1", title: "测试会话", updatedAt: now() },
      { sessionId: "sess_2", title: "另一个会话", updatedAt: now() },
    ],
    current: {
      sessionId: "sess_test1",
      title: "测试会话",
      updatedAt: now(),
      resolvedBy: "latest-updated",
      slug: "s1-abc",
      dir: "E:\\proj\\.无痛切\\sessions\\s1-abc",
      chunkCount: 2,
      job: null,
      draft: null,
      handover: null,
      stale: false,
    },
    ...over,
  };
}

let state = makeState();
let calls = [];
let route = () => null;

function buildDom({ withLucide = true, sessionId = "sess_test1", allowErrors = [] } = {}) {
  // 占位符是裸的 __WTQ_SESSION_ID__：按真实后端的方式用 JSON 替换（无会话 => ""）
  let html = read("index.html")
    .replace('"__WTQ_TOKEN__"', '"tok-test"')
    .replace("__WTQ_CWD__", JSON.stringify("E:\\proj"))
    .replace("__WTQ_SESSION_ID__", JSON.stringify(sessionId));
  if (html.includes("__WTQ_")) {
    // 只检查"占位符"（前后双下划线），window.__WTQ_TOKEN 这类属性名是正常的
    const leftovers = html.match(/__WTQ_[A-Z_]*__/g);
    if (leftovers) throw new Error("index.html 里有没替换掉的注入占位符：" + leftovers.join(", "));
  }
  html = html.replace('<script src="/lucide.min.js"></script>', "").replace('<script src="/app.js"></script>', "");

  const virtualConsole = new VirtualConsole();
  const guard = createErrorGuard(allowErrors);
  virtualConsole.on("jsdomError", (err) => guard.add("jsdomError", err?.stack || err?.message || err));
  virtualConsole.on("error", (...args) => guard.add("console.error", args.join(" ")));

  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://127.0.0.1:9999/", virtualConsole });
  const { window } = dom;

  window.addEventListener("error", (ev) => guard.add("window.onerror", ev.message || ev.error || "unknown"));
  window.addEventListener("unhandledrejection", (ev) => guard.add("unhandledrejection", ev.reason?.stack || ev.reason || "unknown"));
  // jsdom 没实现 Element.scrollIntoView（真实浏览器都有）。补上空实现，避免把环境差异误判成前端错误。
  if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = function () {};
  dom.__guard = guard;

  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const pathname = u.split("?")[0];
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    const custom = route(pathname, opts, u);
    if (custom) return reply(custom.status ?? 200, custom.body ?? {});
    if (pathname === "/api/state") {
      // 模拟后端：带 sessionId 时按显式选择解析
      let sess = null;
      try {
        sess = new URL(u, "http://127.0.0.1:9999").searchParams.get("sessionId");
      } catch {
        sess = null;
      }
      if (sess && state.current && sess !== state.current.sessionId) {
        return reply(200, { ...state, current: { ...state.current, sessionId: sess, title: sess === "sess_2" ? "另一个会话" : state.current.title, slug: `s-${sess}`, resolvedBy: "explicit" } });
      }
      return reply(200, state);
    }
    if (pathname === "/api/prepare-switch") {
      const sent = JSON.parse(opts.body || "{}");
      return reply(202, {
        ok: true,
        sessionId: sent.sessionId || "sess_test1",
        status: "queued",
        background: true,
        jobId: "job-new",
        draft: makeDraft(),
        handover: null,
        job: { jobId: "job-new", status: "queued", mode: "prepare-switch", phase: "queued", startedAt: now(), draft: makeDraft() },
      });
    }
    if (pathname === "/api/job") {
      const job = state.current?.job ?? null;
      return reply(200, {
        ok: true,
        sessionId: state.current?.sessionId || "sess_test1",
        job,
        draft: state.current?.draft ?? job?.draft ?? null,
        handover: state.current?.handover ?? job?.total ?? job?.handover ?? null,
        stale: Boolean(state.current?.stale),
      });
    }
    if (pathname === "/api/chunk") return reply(200, { file: "TOTAL.md", markdown: "# 交接文档全文\n\n正文内容" });
    if (pathname === "/api/session") return reply(200, { slug: "s1-abc", dir: state.current ? state.current.dir : "", files: [] });
    if (pathname === "/api/open-folder") return reply(200, { ok: true });
    if (pathname === "/api/archive") return reply(200, { ok: true, newCount: 2 });
    if (pathname === "/api/config") {
      const patch = JSON.parse(opts.body || "{}").patch || {};
      state.config = { ...state.config, ...patch }; // 真实后端会落盘，后续 GET 读到的就是新值
      return reply(200, { config: state.config });
    }
    return reply(404, { error: "not found" });
  };

  if (withLucide) {
    const s = window.document.createElement("script");
    s.textContent = read("lucide.min.js");
    window.document.body.append(s);
  }
  const app = window.document.createElement("script");
  app.textContent = read("app.js");
  window.document.body.append(app);
  return dom;
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** 可见主色按钮数量：主按钮 + 当前显示的状态面板内部 */
function visiblePrimaryCount(t) {
  let n = t("btnPrepare").classList.contains("primary") ? 1 : 0;
  for (const id of ["jobIdle", "jobRunning", "jobSuccess", "jobError"]) {
    const view = t(id);
    if (view && !view.hidden) n += view.querySelectorAll(".btn.primary").length;
  }
  return n;
}

/** 节点在 DOM 树上是否真的可见（逐级检查 hidden；jsdom 没有布局，只能这样判断） */
function shown(node) {
  for (let n = node; n; n = n.parentElement) if (n.hidden) return false;
  return true;
}

async function main() {
  const dom = buildDom();
  const { window } = dom;
  const doc = window.document;
  const t = (id) => doc.getElementById(id);
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const change = (el) => el.dispatchEvent(new window.Event("change", { bubbles: true }));

  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("denied"); } },
  });

  await tick(80);

  /* ---------- 1. 初始 idle ---------- */
  eq(t("currentTitle").textContent, "测试会话", "当前会话标题");
  eq(t("currentResolved").textContent, "已自动选择最近使用的会话", "resolvedBy=latest-updated 提示");
  ok(!t("jobIdle").hidden && t("jobRunning").hidden && t("jobSuccess").hidden && t("jobError").hidden, "初始显示 idle 视图");
  eq(t("btnPrepareLabel").textContent, "准备切换会话", "主按钮文案");
  ok(!t("btnPrepare").disabled, "有会话时主按钮可用");
  has(t("idleText").textContent, "已归档 2 段", "idle 文案带归档段数");
  eq(t("historyCount").textContent, "1 个会话", "历史计数");
  eq(t("choicesCount").textContent, "2 个可选", "可选会话计数");
  ok(Boolean(t("btnRefresh").querySelector("svg")), "lucide 图标已替换为 svg");
  ok(t("btnRefresh").getAttribute("aria-label") === "刷新" && t("btnRefresh").getAttribute("title") === "刷新", "图标按钮有无障碍名和 tooltip");
  ok(!doc.documentElement.classList.contains("no-icons"), "lucide 可用时不加 no-icons");
  ok(t("btnPrepare").classList.contains("primary"), "idle 态主按钮是唯一主色按钮");
  eq(visiblePrimaryCount(t), 1, "idle 态屏幕上仅一个主色按钮");

  /* ---------- 2. prepare-switch → running ---------- */
  state = makeState({ current: { ...makeState().current, job: { jobId: "job-new", status: "running", mode: "prepare-switch", phase: "archive", startedAt: now() } } });
  click(t("btnPrepare"));
  await tick(60);
  ok(!t("jobRunning").hidden, "点击后立刻进入进行中视图");
  eq(t("runPhase").textContent, "已排队，马上开始", "乐观 queued 阶段文案");
  eq(t("btnPrepareLabel").textContent, "正在准备…", "进行中主按钮文案");
  ok(t("btnPrepare").disabled, "进行中主按钮禁用");
  has(t("runHint").textContent, "页面可以关掉", "进行中提示任务会继续");

  state.current.job.phase = "merge";
  await window.refresh({ silent: true });
  await tick(20);
  eq(t("runPhase").textContent, "正在生成交接文档", "phase=merge 文案");
  has(t("runHint").textContent, "页面可以关掉", "进行中提示（merge）");

  /* ---------- 3. 成功态 ---------- */
  const handover = makeHandover();
  state = makeState({ current: { ...makeState().current, job: { jobId: "job-new", status: "done", mode: "prepare-switch", phase: "done", startedAt: iso(-30000), finishedAt: now() }, handover } });
  await window.refresh({ silent: true });
  await tick(20);
  ok(!t("jobSuccess").hidden && t("jobRunning").hidden, "成功态显示");
  eq(t("succTitle").textContent, "交接已准备好", "成功标题");
  has(t("succMeta").textContent, "共 3 段", "成功元信息段数");
  has(t("succMeta").textContent, "已包含当前未压缩内容", "成功元信息 liveIncluded");
  has(t("succPath").textContent, "TOTAL.md", "成功态显示交接文档路径");
  eq(t("hlOverview").textContent, "在做无痛切面板", "一句话总览");
  eq(t("hlConclusions").textContent, "1. 前端已重写", "最终结论");
  eq(t("hlConstraints").textContent, "不要用蓝色", "用户偏好");
  ok(!t("succWarnings").hidden && t("succWarnings").textContent.includes("旧模型"), "warnings 显示");
  ok(t("succStale").hidden, "非 stale 不显示落后提示");
  eq(t("btnPrepareLabel").textContent, "重新准备交接", "成功态主按钮文案");
  ok(!t("btnPrepare").classList.contains("primary"), "成功态只保留一个主色按钮（复制）");
  ok(t("btnCopy").classList.contains("primary"), "成功态复制按钮是主色");
  eq(visiblePrimaryCount(t), 1, "屏幕上主色按钮只有一个");

  /* ---------- 4. 复制降级 + 轮询不拆 DOM ---------- */
  click(t("btnCopy"));
  await tick(60);
  ok(!t("copyFallback").hidden, "剪贴板被拒时显示文本框降级");
  eq(t("copyText").value, handover.handoverText, "降级文本框内容 = handoverText");
  has(t("copyMsg").textContent, "手动复制", "复制失败提示");
  // 降级路径的「全选并复制」按钮（jsdom 没有 execCommand，应给出手动提示而不是抛错）
  click(t("btnSelectCopy"));
  await tick(20);
  has(t("copyMsg").textContent, "Ctrl+C", "降级按钮提示手动复制");
  const ta = t("copyText");
  const msg = t("copyMsg");
  await window.refresh({ silent: true });
  await window.refresh({ silent: true });
  await tick(20);
  ok(t("copyText") === ta, "轮询后文本框节点未被重建");
  ok(t("copyMsg") === msg, "轮询后复制反馈未被清掉");
  eq(t("copyText").value, handover.handoverText, "轮询后文本框内容仍在");
  ok(!t("copyFallback").hidden, "轮询后降级框仍可见");

  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
  click(t("btnCopy"));
  await tick(60);
  ok(t("copyFallback").hidden, "复制成功后收起降级框");
  has(t("copyMsg").textContent, "已复制", "复制成功提示");

  click(t("btnViewTotal"));
  await tick(60);
  eq(t("docBody").textContent, "# 交接文档全文\n\n正文内容", "文档对话框内容");
  has(t("docTitle").textContent, "交接文档", "文档对话框标题");

  /* ---------- 5. stale 提示 ---------- */
  state.current.stale = true;
  await window.refresh({ silent: true });
  await tick(20);
  ok(!t("succStale").hidden, "stale 时显示落后提示");
  has(t("succStale").textContent, "又有新消息", "stale 文案");
  state.current.stale = false;

  /* ---------- 6. 设置：只在打开时挂载，轮询不重建 ---------- */
  t("foldAdvanced").open = true;
  window.renderAdvanced();
  await tick(20);
  ok(t("settingsForm").children.length >= 7, "设置表单已挂载");
  const rawInit = t("set-saveRaw");
  ok(rawInit && rawInit.type === "checkbox", "布尔设置是 checkbox 而不是 select");
  ok(rawInit && rawInit.checked === true, "saveRaw 初始值");
  ok(Boolean(t("set-skipLiveForTotal")) === false, "skipLiveForTotal 不是用户设置项");
  const rawNode = t("set-saveRaw");
  rawNode.checked = false;
  change(rawNode);
  await tick(80);
  const cfgCall = calls.filter((c) => c.url.startsWith("/api/config")).pop();
  ok(cfgCall && cfgCall.body.includes('"saveRaw":false'), "bool 设置保存为布尔值");
  has(t("settingsStatus").textContent, "已保存", "保存成功反馈");
  ok(t("settingsStatus").className.includes("ok"), "保存反馈样式为成功");
  await window.refresh({ silent: true });
  await window.refresh({ silent: true });
  await tick(20);
  ok(t("set-saveRaw") === rawNode, "轮询后设置控件节点未被重建");
  eq(t("set-saveRaw").checked, false, "轮询后设置值未被覆盖");
  eq(t("providerList").querySelectorAll(".prov").length, 1, "供应商列表渲染");
  const contextNode = t("set-summaryContextTokens");
  const outputNode = t("set-summaryOutputTokens");
  eq(contextNode.type, "number", "上下文预算使用数字控件");
  eq(contextNode.value, "65536", "上下文预算显示默认值");
  eq(outputNode.value, "8192", "输出预算显示默认值");
  eq(contextNode.step, "1", "上下文预算支持精确整数");
  eq(outputNode.step, "1", "输出预算支持精确整数");
  ok(contextNode.checkValidity() && outputNode.checkValidity(), "默认预算不能因步进不匹配而无效");
  contextNode.value = "32768";
  change(contextNode);
  await tick(80);
  const contextCall = calls.filter((c) => c.url.startsWith("/api/config")).pop();
  has(contextCall.body, '"summaryContextTokens":32768', "上下文预算按数字保存");
  has(t("settingsStatus").textContent, "已保存", "上下文预算保存反馈");
  outputNode.value = "4096";
  change(outputNode);
  await tick(80);
  const outputCall = calls.filter((c) => c.url.startsWith("/api/config")).pop();
  has(outputCall.body, '"summaryOutputTokens":4096', "输出预算按数字保存");
  has(t("settingsStatus").textContent, "已保存", "输出预算保存反馈");
  const beforeInvalid = calls.filter((c) => c.url.startsWith("/api/config")).length;
  contextNode.value = "4096";
  change(contextNode);
  await tick(20);
  eq(calls.filter((c) => c.url.startsWith("/api/config")).length, beforeInvalid, "非法组合不发送保存请求");
  has(t("settingsStatus").textContent, "1536", "非法组合显示预算余量要求");
  ok(t("settingsStatus").className.includes("bad"), "非法组合显示错误而非保存成功");
  outputNode.value = "4096.5";
  change(outputNode);
  await tick(20);
  eq(calls.filter((c) => c.url.startsWith("/api/config")).length, beforeInvalid, "小数预算不发送保存请求");
  has(t("settingsStatus").textContent, "正整数", "小数预算显示明确要求");
  contextNode.value = "32768";
  outputNode.value = "4096";
  await window.refresh({ silent: true });
  await tick(20);
  eq(contextNode.value, "32768", "刷新后上下文预算保持已保存值");
  eq(outputNode.value, "4096", "刷新后输出预算保持已保存值");

  /* ---------- 7. 选择其它会话（记忆 + URL） ---------- */
  const radio = t("choicesList").querySelector('input[value="sess_2"]');
  ok(Boolean(radio), "可选会话单选框存在");
  radio.checked = true;
  change(radio);
  await tick(80);
  const lastState = calls.filter((c) => c.url.startsWith("/api/state")).pop();
  has(lastState.url, "sessionId=sess_2", "选择会话后带上 sessionId 请求");
  has(window.location.search, "sessionId=sess_2", "URL 记住选择");
  eq(window.localStorage.getItem("wtq.pinnedSessionId"), "sess_2", "本地记忆 pinned 会话");
  eq(t("currentResolved").textContent, "已按你的选择", "手动选择提示");

  const auto = t("choicesList").querySelector('input[value=""]');
  auto.checked = true;
  change(auto);
  await tick(80);
  eq(window.localStorage.getItem("wtq.pinnedSessionId"), null, "切回自动后清除本地记忆");
  ok(!window.location.search.includes("sessionId="), "切回自动后 URL 清掉参数");

  /* ---------- 8. 失败态 + 旧交接 + 重试 ---------- */
  const older = makeHandover({ builtAt: iso(-3600000) });
  state = makeState({
    current: {
      ...makeState().current,
      job: { status: "error", mode: "prepare-switch", phase: "merge", error: "模型调用失败：401 无效密钥", startedAt: iso(-120000), finishedAt: now() },
      handover: older,
    },
  });
  await window.refresh({ silent: true });
  await tick(20);
  ok(!t("jobError").hidden && t("jobSuccess").hidden, "失败态显示");
  has(t("errText").textContent, "401", "失败原因展示");
  ok(!t("prevHandover").hidden, "失败时显示上一次交接");
  has(t("prevHandoverText").textContent, "早于本次失败", "旧交接明确标注较早");
  eq(t("btnPrepareLabel").textContent, "重试准备交接", "失败态主按钮=重试");
  click(t("btnRetry"));
  await tick(80);
  const post = calls.filter((c) => c.url.startsWith("/api/prepare-switch")).pop();
  eq(JSON.parse(post.body).cwd, "E:\\proj", "重试请求带 cwd");
  eq(JSON.parse(post.body).sessionId, "sess_test1", "重试请求带 sessionId");

  /* ---------- 9. POST 失败也要持久显示 ---------- */
  state = makeState();
  await window.refresh({ silent: true });
  await tick(20);
  route = (pathname) => (pathname === "/api/prepare-switch" ? { status: 500, body: { error: "面板内部错误 boom" } } : null);
  click(t("btnPrepare"));
  await tick(80);
  ok(!t("jobError").hidden, "POST 失败也进入失败视图");
  has(t("errText").textContent, "boom", "POST 失败原因展示");
  await window.refresh({ silent: true });
  await tick(20);
  ok(!t("jobError").hidden, "轮询后失败信息仍在（不是一秒 toast）");
  route = () => null;

  /* ---------- 10. 供应商不可用 / 供应商为空 横幅 ---------- */
  state = makeState({ providers: [{ providerId: "p1", name: "P1", usable: false, enabled: true, models: [], baseUrl: "https://x", hasKey: false }] });
  await window.refresh({ silent: true });
  await tick(20);
  has(t("banners").textContent, "没有可用的模型供应商", "无可用供应商提示");

  state = makeState({ providers: [] });
  await window.refresh({ silent: true });
  await tick(20);
  has(t("banners").textContent, "没有可用的模型供应商", "供应商为空数组时也有提示");

  /* ---------- 11. 空归档 / 未归档 / 立即归档 ---------- */
  state = makeState({ sessions: [], unarchived: [{ id: "sess_3", sessionId: "sess_3", title: "新会话", pendingCompactions: 4, updatedAt: now(), running: false }] });
  await window.refresh({ silent: true });
  await tick(20);
  has(t("sessionsList").textContent, "还没有归档", "空归档提示");
  ok(!t("unarchivedBox").hidden, "未归档列表显示");
  has(t("unarchivedList").textContent, "4 个压缩边界待归档", "未归档信息");
  click(t("unarchivedList").querySelector('[data-act="archive"]'));
  await tick(80);
  ok(calls.some((c) => c.url === "/api/archive" && c.body.includes("sess_3")), "立即归档调用 /api/archive");

  /* ---------- 12. 无会话：安静 idle + currentError 横幅 ---------- */
  state = makeState({ current: null, currentError: "当前工作区还没有可交接的对话。", sessions: [], choices: [] });
  await window.refresh({ silent: true });
  await tick(20);
  has(t("banners").textContent, "当前会话不可用", "无会话时显示 currentError");
  has(t("currentTitle").textContent, "没有可交接的会话", "无会话标题");
  ok(t("btnPrepare").disabled, "无会话时主按钮禁用");
  has(t("prepareHint").textContent, "还没有可交接的会话", "无会话提示");
  ok(!t("jobIdle").hidden, "无会话时主面板保持 idle（错误交给横幅）");

  /* ---------- 13. 高级区懒渲染 + 打开目录 ---------- */
  state = makeState();
  await window.refresh({ silent: true });
  t("foldAdvanced").open = false;
  await window.refresh({ silent: true });
  t("foldAdvanced").open = true;
  window.renderAdvanced();
  await tick(20);
  has(t("rootPath").textContent, ".无痛切", "归档根目录显示");
  ok(t("log").textContent.includes("chunk"), "日志渲染");
  click(t("foldAdvanced").querySelector('[data-act="root-folder"]'));
  await tick(60);
  ok(calls.some((c) => c.url === "/api/open-folder"), "打开归档根目录调用 open-folder");

  /* ---------- 14. 403 可见（放最后：之后不再轮询） ---------- */
  route = (pathname) => (pathname === "/api/state" ? { status: 403, body: { error: "bad token" } } : null);
  await window.refresh({ silent: true });
  await tick(20);
  has(t("banners").textContent, "面板令牌无效", "403 显示可见横幅");
  ok(t("btnPrepare").disabled, "403 后主按钮禁用");
  route = () => null;

  dom.__guard.assertClean("主流程");
  window.close();

  /* ---------- 15. lucide 缺失时降级（唯一允许出现脚本错误的用例） ---------- */
  const dom2 = buildDom({ withLucide: false, allowErrors: [/lucide\.min\.js/] });
  await tick(40);
  ok(dom2.window.document.documentElement.classList.contains("no-icons"), "lucide 缺失时加 no-icons 类");
  ok(Boolean(dom2.window.document.querySelector(".icon-btn[data-fallback]")), "图标按钮带文字回退标记");
  dom2.__guard.assertClean("lucide 缺失用例");
  dom2.window.close();

  /* ---------- 16. __WTQ_SESSION_ID 注入：有会话 / 无会话两种 JSON 替换 ---------- */
  // 16a. 无会话：JSON 空字符串，页面照常工作，且不出现"改用打开面板时的会话"兜底入口
  state = makeState({ current: null, currentError: "当前工作区还没有可交接的对话。", sessions: [], choices: [] });
  const domUnbound = buildDom({ sessionId: "" });
  await tick(80);
  {
    const d = domUnbound.window.document;
    const banners = d.getElementById("banners").textContent;
    eq(d.getElementById("currentTitle").textContent, "没有可交接的会话", "无会话注入：面板正常渲染");
    has(banners, "当前会话不可用", "无会话注入：currentError 横幅可见");
    ok(!banners.includes("改用打开面板时的会话"), "无会话注入：不显示兜底入口");
    ok(d.getElementById("btnPrepare").disabled, "无会话注入：主按钮禁用");
    domUnbound.__guard.assertClean("注入 JSON 空串用例");
  }
  domUnbound.window.close();

  // 16b. 有会话：JSON 字符串，currentError 时出现兜底入口
  const domBound = buildDom({ sessionId: "sess_from_open" });
  await tick(80);
  {
    const d = domBound.window.document;
    const banners = d.getElementById("banners").textContent;
    has(banners, "当前会话不可用", "有会话注入：currentError 横幅可见");
    has(banners, "改用打开面板时的会话", "有会话注入：出现兜底入口");
    eq(domBound.window.__WTQ_SESSION_ID, "sess_from_open", "注入的会话 id 可读");
    domBound.__guard.assertClean("注入 JSON 字符串用例");
  }
  domBound.window.close();

  /* ---------- 17. id-aware 与进度语义（原两条缺陷，现已断言期望行为） ---------- */
  state = makeState();
  const probe = buildDom({ sessionId: "" });
  {
    const w = probe.window;
    const d = w.document;
    const p = (id) => d.getElementById(id);
    const pclick = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

    // 17a. job.progress = 已处理索引，job.count = 总数（后端语义）：进度条与文案都要按 count 换算
    state = makeState({ current: { ...makeState().current, job: { jobId: "job-p", status: "running", mode: "prepare-switch", phase: "merge", progress: 3, count: 12, startedAt: now() } } });
    await w.refresh({ silent: true });
    await tick(20);
    const pct3 = parseFloat(p("runBarFill").style.width);
    const hint3 = p("runHint").textContent;
    ok(Number.isFinite(pct3) && Math.abs(pct3 - 25) <= 0.6, `progress=3/count=12 -> 进度条约 25%（实测 ${p("runBarFill").style.width || "未设置"}）`);
    ok(/3\s*\/\s*12/.test(hint3), `progress=3/count=12 -> 文案含 3/12（实测「${hint3}」）`);
    ok(!hint3.includes("已处理 12 段"), "progress=3/count=12 -> 不把总数当已处理数");

    state = makeState({ current: { ...makeState().current, job: { jobId: "job-p", status: "running", mode: "prepare-switch", phase: "archive", progress: 1, count: 12, startedAt: now() } } });
    await w.refresh({ silent: true });
    await tick(20);
    const pct1 = parseFloat(p("runBarFill").style.width);
    ok(Number.isFinite(pct1) && pct1 >= 7 && pct1 <= 9.5, `progress=1/count=12 -> 进度条约 8%，不再被当成 100%（实测 ${p("runBarFill").style.width || "未设置"}）`);

    // 17b. id-aware：旧 job 的失败状态不能盖住新一次的乐观进行中
    state = makeState({ current: { ...makeState().current, job: { jobId: "job-old", status: "error", mode: "prepare-switch", phase: "merge", error: "上一次失败：401", startedAt: iso(-120000), finishedAt: iso(-60000) } } });
    await w.refresh({ silent: true });
    await tick(20);
    ok(!p("jobError").hidden, "旧 job 失败时先显示失败卡片");

    route = (pathname) => (pathname === "/api/prepare-switch" ? { status: 200, body: { ok: true, sessionId: "sess_test1", job: { jobId: "job-new", status: "queued", mode: "prepare-switch", phase: "queued", startedAt: now() } } } : null);
    pclick(p("btnPrepare"));
    await tick(60);
    ok(!p("jobRunning").hidden && p("jobError").hidden, "新 job 开始后不再显示旧 job 的失败");
    eq(p("runPhase").textContent, "已排队，马上开始", "进行中状态来自新 job（乐观），不是旧的失败");

    // 17c. 同一个 job 变为失败：下一次刷新立刻显示失败，不等乐观窗口过期
    state = makeState({ current: { ...makeState().current, job: { jobId: "job-new", status: "error", mode: "prepare-switch", phase: "merge", error: "模型调用超时", startedAt: iso(-60000), finishedAt: now() } } });
    await w.refresh({ silent: true });
    await tick(20);
    ok(!p("jobError").hidden && p("jobRunning").hidden, "同一 job 失败 -> 立刻切到失败视图");
    has(p("errText").textContent, "模型调用超时", "失败原因立即展示");
    eq(p("btnPrepareLabel").textContent, "重试准备交接", "失败后主按钮变重试");

    route = () => null;
    state = makeState();
    probe.__guard.assertClean("id-aware / 进度语义用例");
  }
  probe.window.close();

  /* ---------- 18. 空归档（chunkCount=0）不许谎称"没有压缩过" ---------- */
  state = makeState({ sessions: [], unarchived: [], current: { ...makeState().current, chunkCount: 0, handover: null, job: null, stale: false } });
  const empty = buildDom({ sessionId: "" });
  await tick(80);
  {
    const d = empty.window.document;
    const idleText = d.getElementById("idleText").textContent;
    const hint = d.getElementById("prepareHint").textContent;
    eq(idleText, "准备交接时会一起整理历史记录和当前对话。", "空归档 idle 文案（chunkCount 只是归档数，不能说没压缩过）");
    eq(hint, "还没有归档记录也没关系，可以直接准备交接。", "空归档提示文案");
    ok(!idleText.includes("还没发生") && !idleText.includes("没有压缩"), "空归档 idle 文案不出现「没压缩过」的错误断言");
    ok(!hint.includes("还没发生") && !hint.includes("没有压缩"), "空归档提示不出现「没压缩过」的错误断言");
    ok(!d.getElementById("btnPrepare").disabled, "空归档也能直接准备交接");
    empty.__guard.assertClean("空归档用例");
  }
  empty.window.close();

  /* ---------- 19. 后台归档（scan）失败：常驻横幅 + 重新归档入口 ---------- */
  state = makeState();
  const scanDom = buildDom({ sessionId: "sess_test1" });
  {
    const w = scanDom.window;
    const d = w.document;
    const p = (id) => d.getElementById(id);
    const pclick = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await tick(80);

    // 19a. 没有失败记录时不许出现归档横幅（避免误报）
    ok(!p("banners").textContent.includes("后台归档"), "19a 无任务时不出现归档横幅");
    state = makeState({ current: { ...makeState().current, job: { jobId: "j1", status: "running", mode: "scan", phase: "archive", progress: 1, count: 3, startedAt: now() } } });
    await w.refresh({ silent: true });
    await tick(20);
    ok(!p("banners").textContent.includes("后台归档"), "19a 归档运行中不显示失败横幅");
    state = makeState({ current: { ...makeState().current, job: { jobId: "j1", status: "done", mode: "scan", phase: "done", newCount: 2, errors: [], fatal: false, finishedAt: now() } } });
    await w.refresh({ silent: true });
    await tick(20);
    ok(!p("banners").textContent.includes("后台归档"), "19a 归档成功（errors 为空）不显示横幅");

    // 19b. status=error：常驻红色横幅，且不进主面板的失败卡片（主面板按设计不管 scan 任务）
    state = makeState({
      current: {
        ...makeState().current,
        job: { jobId: "j2", status: "error", mode: "scan", phase: "error", error: "摘要失败：模型调用失败\n第二行细节", startedAt: iso(-5000), finishedAt: now() },
      },
    });
    await w.refresh({ silent: true });
    await tick(20);
    has(p("banners").textContent, "后台归档失败", "19b scan 出错显示横幅");
    has(p("banners").textContent, "模型调用失败", "19b 横幅带错误原因");
    ok(!p("banners").textContent.includes("第二行细节"), "19b 只展示错误首行");
    ok(p("jobError").hidden, "19b scan 失败仍不进主面板失败卡片（横幅兜底）");
    await w.refresh({ silent: true });
    await tick(20);
    has(p("banners").textContent, "后台归档失败", "19b 刷新后横幅仍在（不是一次性 toast）");

    // 19c. 横幅上的「重新归档」按钮 → POST /api/archive 带当前会话 id
    const archiveBtn = [...p("banners").querySelectorAll("button")].find((b) => b.textContent.includes("重新归档"));
    ok(Boolean(archiveBtn), "19c 横幅带重新归档按钮");
    pclick(archiveBtn);
    await tick(80);
    const archiveCall = calls.filter((c) => c.url === "/api/archive").pop();
    ok(Boolean(archiveCall) && String(archiveCall.body).includes("sess_test1"), "19c 重新归档请求带当前会话 id");

    // 19d. status=stale（进程被中断）走同一条横幅
    state = makeState({
      current: {
        ...makeState().current,
        job: { jobId: "j3", status: "stale", mode: "scan", phase: "error", error: "后台任务已中断，可以重新准备交接。", startedAt: iso(-7200000), finishedAt: now() },
      },
    });
    await w.refresh({ silent: true });
    await tick(20);
    has(p("banners").textContent, "后台归档失败", "19d stale 也走横幅");
    has(p("banners").textContent, "已中断", "19d stale 文案来自 job.error");

    // 19e. done 但 fatal / 有 errors：黄色横幅，说明影响
    state = makeState({
      current: {
        ...makeState().current,
        job: { jobId: "j4", status: "done", mode: "scan", phase: "done", newCount: 0, fatal: true, errors: [{ boundaryId: "b1", error: "摘要失败: HTTP 500" }], finishedAt: now() },
      },
    });
    await w.refresh({ silent: true });
    await tick(20);
    has(p("banners").textContent, "后台归档未成功", "19e fatal（有错且零产出）显示横幅");
    has(p("banners").textContent, "HTTP 500", "19e fatal 横幅带首条错误");

    state = makeState({
      current: {
        ...makeState().current,
        job: { jobId: "j5", status: "done", mode: "scan", phase: "done", newCount: 2, fatal: false, errors: [{ boundaryId: "b2", error: "摘要失败: 超时" }], finishedAt: now() },
      },
    });
    await w.refresh({ silent: true });
    await tick(20);
    has(p("banners").textContent, "1 段没能写成摘要", "19e 部分段失败显示横幅");
    has(p("banners").textContent, "退回使用这些段的原文", "19e 部分段失败说明对交接的影响");

    // 19f. 新一次成功归档覆盖 job 后，横幅自然消失
    state = makeState({ current: { ...makeState().current, job: { jobId: "j6", status: "done", mode: "scan", phase: "done", newCount: 3, errors: [], fatal: false, finishedAt: now() } } });
    await w.refresh({ silent: true });
    await tick(20);
    ok(!p("banners").textContent.includes("后台归档"), "19f 归档成功后横幅消失");

    scanDom.__guard.assertClean("scan 失败横幅用例");
  }
  scanDom.window.close();

  /* ---------- 20. 文档预览：过期请求不许写回对话框 ---------- */
  state = makeState();
  const docDom = buildDom({ sessionId: "sess_test1" });
  {
    const w = docDom.window;
    const d = w.document;
    const p = (id) => d.getElementById(id);
    await tick(80);

    const realFetch = w.fetch;
    const chunkReply = (markdown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ file: "x.md", markdown }) });
    let release = null;
    w.fetch = (url, opts = {}) => {
      const u = String(url);
      if (u.includes("HOLD.md")) return new Promise((res) => { release = () => res(chunkReply("旧文档内容 STALE")); });
      if (u.includes("/api/chunk")) return Promise.resolve(chunkReply("新文档内容 NEW"));
      return realFetch(url, opts);
    };

    // 20a. 先点的慢请求后到：不许覆盖后点的文档
    w.openDoc("s1-abc", "HOLD.md", "旧文档", "");
    await tick(20);
    eq(p("docStatus").textContent, "加载中…", "20a 慢请求期间显示加载中");
    await w.openDoc("s1-abc", "NEW.md", "新文档", "");
    await tick(20);
    eq(p("docBody").textContent, "新文档内容 NEW", "20a 新文档先落地");
    eq(p("docTitle").textContent, "新文档", "20a 标题是新文档");
    ok(typeof release === "function", "20a 旧请求确实被挂起（用例有效）");
    release();
    await tick(60);
    eq(p("docBody").textContent, "新文档内容 NEW", "20a 后到的旧响应被丢弃（预览不串档）");
    eq(p("docStatus").textContent, "", "20a 旧响应不写状态栏");
    ok(p("docRetry").hidden, "20a 旧响应不亮重试");

    // 20b. 对话框已关闭后到达的失败响应：不许写状态/正文/重试按钮
    let fail = null;
    w.fetch = (url, opts = {}) => {
      if (String(url).includes("FAIL.md")) {
        return new Promise((res) => { fail = () => res({ ok: false, status: 500, text: async () => JSON.stringify({ error: "找不到文档：FAIL.md" }) }); });
      }
      return realFetch(url, opts);
    };
    w.openDoc("s1-abc", "FAIL.md", "会失败的文档", "");
    await tick(20);
    d.getElementById("docDialog").dispatchEvent(new w.Event("close"));
    await tick(20);
    ok(typeof fail === "function", "20b 失败请求确实被挂起（用例有效）");
    fail();
    await tick(60);
    eq(p("docStatus").textContent, "", "20b 对话框已关闭：过期失败不写状态栏");
    ok(p("docRetry").hidden, "20b 过期失败不亮重试");
    ok(!p("docBody").textContent.includes("加载失败"), "20b 过期失败不写正文");

    // 20c. 当前请求仍然正常：失败态照常可见（守卫不能把正常错误也吞掉）
    state = makeState();
    await w.refresh({ silent: true });
    w.fetch = (url, opts = {}) => (String(url).includes("FAIL2.md") ? Promise.resolve({ ok: false, status: 500, text: async () => JSON.stringify({ error: "找不到文档：FAIL2.md" }) }) : realFetch(url, opts));
    await w.openDoc("s1-abc", "FAIL2.md", "当前的失败文档", "");
    await tick(20);
    has(p("docStatus").textContent, "加载失败", "20c 当前请求的失败仍然显示");
    ok(!p("docRetry").hidden, "20c 当前请求失败时重试按钮可见");

    docDom.__guard.assertClean("预览请求代数用例");
  }
  docDom.window.close();

  /* ---------- 21. 运行态：草稿可立即复制（含剪贴板被拒的降级） ---------- */
  state = makeState();
  const draftDom = buildDom({ sessionId: "sess_test1" });
  {
    const w = draftDom.window;
    const d = w.document;
    const p = (id) => d.getElementById(id);
    const pclick = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    const copied = [];
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
    await tick(80);

    // 21a. 点「准备切换会话」后，后端随 202 返回的机械草稿应当立刻可复制
    const draftText = makeDraft().handoverText;
    pclick(p("btnPrepare"));
    await tick(60);
    ok(!p("jobRunning").hidden, "21a 点击后进入进行中视图");
    ok(!p("runDraftActions").hidden, "21a 进行中显示草稿复制入口");
    eq(p("btnRunDraftCopy").dataset.text, draftText, "21a 草稿复制按钮携带草稿全文");
    has(p("runDraftText").textContent, "未精炼草稿", "21a 说明草稿会被最终版自动替换");
    ok(p("runPrevActions").hidden, "21a 没有旧交接时不显示「查看上次交接」");

    // 固定到 running + draft（避免 300ms 后的轻量轮询把乐观任务清掉）
    const draft1 = makeDraft();
    const runJob = { jobId: "job-d1", status: "running", mode: "prepare-switch", phase: "merge", startedAt: now() };
    const base21 = makeState().current;
    state = makeState({ current: { ...base21, job: runJob, draft: draft1 } });
    await w.refresh({ silent: true });
    await tick(20);

    // 21b. 剪贴板被拒：降级文本框里必须是草稿全文
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    pclick(p("btnRunDraftCopy"));
    await tick(60);
    ok(!p("copyFallback").hidden, "21b 剪贴板被拒时显示手动复制框");
    eq(p("copyText").value, draft1.handoverText, "21b 手动复制框内容 = 草稿全文");
    has(p("copyMsg").textContent, "手动复制", "21b 提示改为手动复制");
    ok(p("copyMsg").className.includes("warn"), "21b 手动复制提示是警告样式");
    eq(copied.length, 0, "21b 剪贴板被拒期间没有写入任何内容");
    pclick(p("btnSelectCopy"));
    await tick(20);
    has(p("copyMsg").textContent, "Ctrl+C", "21b 「全选并复制」失败时提示按 Ctrl+C");

    // 21c. 剪贴板恢复后，点同一个按钮成功复制草稿
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
    pclick(p("btnRunDraftCopy"));
    await tick(60);
    ok(p("copyFallback").hidden, "21c 草稿复制成功后收起手动复制框");
    eq(copied[0], draft1.handoverText, "21c 写入剪贴板的是草稿全文");
    has(p("copyMsg").textContent, "已复制", "21c 草稿复制成功提示");

    // 21d. 同时有旧最终版：草稿复制入口仍在，旧版可查看
    const oldFinal = makeHandover({ builtAt: iso(-1800000) });
    state = makeState({ current: { ...base21, job: runJob, draft: draft1, handover: oldFinal } });
    await w.refresh({ silent: true });
    await tick(20);
    ok(!p("runDraftActions").hidden, "21d 草稿复制入口仍在（不被旧最终版顶掉）");
    ok(!p("runPrevActions").hidden, "21d 显示「查看上次交接」入口");
    has(p("runPrevText").textContent, "上一版最终交接生成于", "21d 旧版入口标注生成时间");
    pclick(p("btnRunPrevView"));
    await tick(60);
    eq(p("docBody").textContent, "# 交接文档全文\n\n正文内容", "21d 进行中也能打开旧交接文档");

    // 21e. 没有草稿时不显示草稿入口
    state = makeState({ current: { ...base21, job: runJob, draft: null, handover: oldFinal } });
    await w.refresh({ silent: true });
    await tick(20);
    ok(p("runDraftActions").hidden, "21e 没有草稿时隐藏草稿复制入口");
    ok(!p("runPrevActions").hidden, "21e 旧版查看入口保留");
    ok(p("btnRunDraftCopy").dataset.text === "" || !shown(p("runDraftActions")), "21e 隐藏的草稿复制按钮不参与交互");

    draftDom.__guard.assertClean("运行态草稿复制用例");
  }
  draftDom.window.close();

  /* ---------- 22. 失败态草稿优先旧最终版；done 后最终版替换草稿 ---------- */
  const draft2 = makeDraft();
  const oldFinal2 = makeHandover({ builtAt: iso(-3600000), handoverText: "旧最终版提示词 OLD-FINAL" });
  const errJob = { jobId: "job-e1", status: "error", mode: "prepare-switch", phase: "merge", error: "模型调用失败：401 无效密钥", startedAt: iso(-120000), finishedAt: now() };
  const base22 = makeState().current;
  state = makeState({ current: { ...base22, job: errJob, draft: draft2, handover: oldFinal2 } });
  const errDom = buildDom({ sessionId: "sess_test1" });
  {
    const w = errDom.window;
    const d = w.document;
    const p = (id) => d.getElementById(id);
    const pclick = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    const copied = [];
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
    await tick(80);

    // 22a. 失败 + 机械草稿 + 旧最终版：草稿是首选复制源
    ok(!p("jobError").hidden && p("jobSuccess").hidden, "22a 失败态显示");
    has(p("errText").textContent, "401", "22a 展示失败原因");
    ok(!p("prevHandover").hidden, "22a 提供可复制的兜底内容");
    has(p("prevHandoverText").textContent, "机械草稿仍然保留", "22a 文案指向草稿（不是旧最终版）");
    ok(!p("prevHandoverText").textContent.includes("早于本次失败"), "22a 不把旧最终版当作首选复制源");
    has(p("btnPrevCopy").textContent, "复制当前草稿", "22a 按钮文案指向当前草稿");
    eq(p("btnPrevCopy").dataset.text, draft2.handoverText, "22a 复制内容 = 草稿全文");
    ok(p("btnPrevCopy").dataset.text !== oldFinal2.handoverText, "22a 不复制旧最终版");
    ok(!p("btnPrevView").hidden, "22a 旧最终版仍可查看");
    pclick(p("btnPrevCopy"));
    await tick(60);
    eq(copied[0], draft2.handoverText, "22a 剪贴板拿到草稿全文");

    // 22a'. 没有草稿时退回旧最终版（对照组）
    state = makeState({ current: { ...base22, job: errJob, draft: null, handover: oldFinal2 } });
    await w.refresh({ silent: true });
    await tick(20);
    has(p("prevHandoverText").textContent, "早于本次失败", "22a 无草稿时明确标注旧最终版更早");
    has(p("btnPrevCopy").textContent, "复制旧提示", "22a 无草稿时按钮改为复制旧提示");
    eq(p("btnPrevCopy").dataset.text, oldFinal2.handoverText, "22a 无草稿时复制旧最终版全文");

    // 22b. 同一 job 完成后：最终版替换草稿
    const final2 = makeHandover({ highlights: { overview: "最终版总览", conclusions: "最终结论", constraints: "最终约束" }, handoverText: "最终交接提示词 FINAL" });
    const doneJob = { jobId: "job-e1", status: "done", mode: "prepare-switch", phase: "done", startedAt: iso(-60000), finishedAt: now(), draft: draft2, total: final2 };
    state = makeState({ current: { ...base22, job: doneJob, draft: draft2, handover: final2 } });
    await w.refresh({ silent: true });
    await tick(20);
    ok(!p("jobSuccess").hidden && p("jobError").hidden, "22b 完成后切到成功态");
    eq(p("succTitle").textContent, "交接已准备好", "22b 完成态标题不是机械版");
    eq(p("hlOverview").textContent, "最终版总览", "22b 要点来自最终版");
    ok(p("hlOverview").textContent !== draft2.highlights.overview, "22b 不再展示草稿要点");
    eq(p("btnCopy").dataset.text, final2.handoverText, "22b 复制按钮 = 最终版全文");
    ok(!shown(p("runDraftActions")), "22b done 后草稿复制入口不再可见");
    pclick(p("btnCopy"));
    await tick(60);
    eq(copied.at(-1), final2.handoverText, "22b 剪贴板拿到最终版提示词");

    errDom.__guard.assertClean("失败态草稿优先 / done 替换草稿用例");
  }
  errDom.window.close();

  /* ---------- 23. fallback 文案：机械版 / 缺 handoverText / 缺路径 / 缺要点 ---------- */
  state = makeState();
  const fbDom = buildDom({ sessionId: "sess_test1" });
  {
    const w = fbDom.window;
    const d = w.document;
    const p = (id) => d.getElementById(id);
    const pclick = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    const copied = [];
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
    await tick(80);
    const doneJob = { jobId: "job-f1", status: "done", mode: "prepare-switch", phase: "done", finishedAt: now() };
    const base23 = makeState().current;

    // 23a. isFallback：机械版最终交接要有明确标题，且没有 warnings 时不显示警告框
    state = makeState({ current: { ...base23, job: doneJob, handover: makeHandover({ isFallback: true, warnings: [], highlights: { overview: "机械总览" } }) } });
    await w.refresh({ silent: true });
    await tick(20);
    eq(p("succTitle").textContent, "交接已生成（机械版）", "23a isFallback 标题说明是机械版");
    ok(p("succWarnings").hidden, "23a 空 warnings 不显示警告框");

    // 23b. 缺 handoverText：回退到标准提示词（把路径嵌进去）
    const pth = "E:\\proj\\.无痛切\\sessions\\s1-abc\\TOTAL.md";
    state = makeState({ current: { ...base23, job: doneJob, handover: makeHandover({ handoverText: "", totalPath: pth, warnings: [] }) } });
    await w.refresh({ silent: true });
    await tick(20);
    const expectedText = `继续之前的工作。请先读取以下交接文档：\n${pth}\n读取后先告诉我当前进展、未完成事项和下一步建议。`;
    eq(p("btnCopy").dataset.text, expectedText, "23b 缺 handoverText 时回退到标准提示词");
    pclick(p("btnCopy"));
    await tick(60);
    eq(copied.at(-1), expectedText, "23b 剪贴板拿到回退提示词");
    has(p("succPath").textContent, "TOTAL.md", "23b 有路径时状态行显示交接文档路径");

    // 23c. 缺 path：状态行给归档目录兜底文案
    state = makeState({ current: { ...base23, job: doneJob, handover: makeHandover({ totalPath: "", path: "" }) } });
    await w.refresh({ silent: true });
    await tick(20);
    eq(p("succPath").textContent, "交接文档已写入归档目录。", "23c 缺路径时的兜底文案");
    eq(p("succPath").title, "", "23c 缺路径时 title 为空");

    // 23d. 缺要点 / liveIncluded=false / 模型名
    state = makeState({ current: { ...base23, job: doneJob, handover: makeHandover({ highlights: {}, warnings: [], liveIncluded: false, model: "p1/m1" }) } });
    await w.refresh({ silent: true });
    await tick(20);
    for (const id of ["hlOverview", "hlConclusions", "hlConstraints"]) eq(p(id).textContent, "（这一节没有内容）", `23d 缺要点时 ${id} 显示占位`);
    ok(!p("hlEmpty").hidden, "23d 缺要点时显示「没解析出要点」提示");
    has(p("succMeta").textContent, "未包含未压缩内容", "23d liveIncluded=false 的元信息");
    has(p("succMeta").textContent, "p1/m1", "23d 元信息显示模型名");
    ok(p("succWarnings").hidden, "23d 空 warnings 不显示警告框");
    eq(p("succTitle").textContent, "交接已准备好", "23d 非 fallback 标题正常");

    fbDom.__guard.assertClean("fallback 文案用例");
  }
  fbDom.window.close();

  /* ---------- 24. 历史 / 未归档按钮防重 ---------- */
  const busyJob = { jobId: "job-busy", status: "running", mode: "prepare-switch", phase: "merge", startedAt: now() };
  const scanJob = { jobId: "job-scan", status: "running", mode: "scan", phase: "archive", startedAt: now() };
  const curRow = { slug: "s1-abc", sessionId: "sess_test1", title: "测试会话", chunkCount: 2, chunks: [], updatedAt: now(), running: false, job: null };
  const otherRow = { slug: "s2-def", sessionId: "sess_2", title: "另一个会话", chunkCount: 1, chunks: [], updatedAt: now(), running: true, job: busyJob };
  const scanUnarch = { id: "sess_3", sessionId: "sess_3", title: "新会话", pendingCompactions: 4, updatedAt: now(), running: true, job: scanJob };
  const baseCur = makeState().current;
  state = makeState({ sessions: [curRow, otherRow], unarchived: [scanUnarch], current: { ...baseCur, job: null } });
  const busyDom = buildDom({ sessionId: "sess_test1" });
  {
    const w = busyDom.window;
    const d = w.document;
    const p = (id) => d.getElementById(id);
    const pclick = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    const rowOf = (box, needle) => [...box.querySelectorAll(".row")].find((r) => r.textContent.includes(needle));
    const actOf = (row, act) => row.querySelector(`button[data-act="${act}"]`);
    await tick(80);

    // 24a. 有后台任务的会话：行内按钮禁用并显示处理中
    const otherArchiveRow = rowOf(p("sessionsList"), "另一个会话");
    ok(Boolean(otherArchiveRow), "24a 非当前会话的归档行已渲染");
    const otherPrepare = actOf(otherArchiveRow, "prepare");
    ok(otherPrepare.disabled, "24a 该会话有后台任务时准备按钮禁用");
    eq(otherPrepare.textContent, "处理中…", "24a 准备按钮显示处理中");
    eq(otherPrepare.title, "该会话已有后台任务", "24a 禁用原因有 tooltip");
    const curPrepare = actOf(rowOf(p("sessionsList"), "测试会话"), "prepare");
    ok(curPrepare && !curPrepare.disabled, "24a 没有任务的会话准备按钮可用");
    const scanRow = rowOf(p("unarchivedList"), "新会话");
    const scanArchiveBtn = actOf(scanRow, "archive");
    ok(scanArchiveBtn.disabled, "24a 归档中的未归档会话禁用「立即归档」");
    eq(scanArchiveBtn.textContent, "处理中…", "24a 立即归档按钮显示处理中");
    eq(scanArchiveBtn.title, "该会话已有后台任务", "24a 立即归档禁用原因有 tooltip");
    ok(!actOf(scanRow, "prepare").disabled, "24a 仅归档中时「准备交接」仍可用");

    // 24b. 后台任务进行中：程序性点击也不会重复发请求（真实浏览器里按钮已禁用）
    const scanArchiveBefore = calls.filter((c) => c.url === "/api/archive" && String(c.body).includes("sess_3")).length;
    pclick(scanArchiveBtn);
    await tick(60);
    eq(calls.filter((c) => c.url === "/api/archive" && String(c.body).includes("sess_3")).length, scanArchiveBefore, "24b 归档中的会话不会重复提交归档");
    state = makeState({
      sessions: [{ ...curRow, running: true, job: busyJob }, otherRow],
      unarchived: [{ id: "sess_test1", sessionId: "sess_test1", title: "测试会话", pendingCompactions: 2, updatedAt: now(), running: true, job: busyJob }],
      current: { ...baseCur, job: busyJob },
    });
    await w.refresh({ silent: true });
    await tick(20);
    const busyCurRow = actOf(rowOf(p("sessionsList"), "测试会话"), "prepare");
    const busyUnarchRow = rowOf(p("unarchivedList"), "测试会话");
    ok(busyCurRow.disabled, "24b 当前会话进行中：归档行准备按钮禁用");
    ok(actOf(busyUnarchRow, "prepare").disabled, "24b 当前会话进行中：未归档行准备按钮禁用");
    ok(actOf(busyUnarchRow, "archive").disabled, "24b 当前会话进行中：未归档行归档按钮禁用");
    const prepareBefore = calls.filter((c) => c.url.startsWith("/api/prepare-switch")).length;
    const archiveBefore = calls.filter((c) => c.url === "/api/archive").length;
    pclick(busyCurRow);
    pclick(actOf(busyUnarchRow, "prepare"));
    pclick(actOf(busyUnarchRow, "archive"));
    await tick(60);
    eq(calls.filter((c) => c.url.startsWith("/api/prepare-switch")).length, prepareBefore, "24b 进行中的会话不会重复发起准备交接");
    eq(calls.filter((c) => c.url === "/api/archive").length, archiveBefore, "24b 进行中的会话不会重复发起归档");

    // 24c. 主按钮连点：POST 未返回前只允许一个请求
    state = makeState();
    await w.refresh({ silent: true });
    await tick(20);
    const realFetch = w.fetch;
    let posts = 0;
    let release = null;
    w.fetch = (url, opts = {}) => {
      if (String(url).startsWith("/api/prepare-switch")) {
        posts += 1;
        return new Promise((res) => {
          release = () => res({ ok: true, status: 202, text: async () => JSON.stringify({ ok: true, sessionId: "sess_test1", status: "queued", jobId: "job-dup", draft: makeDraft(), job: { jobId: "job-dup", status: "queued", mode: "prepare-switch", phase: "queued", startedAt: now() } }) });
        });
      }
      return realFetch(url, opts);
    };
    pclick(p("btnPrepare"));
    ok(p("btnPrepare").disabled, "24c 点击后立刻禁用主按钮");
    eq(p("btnPrepareLabel").textContent, "正在准备…", "24c 点击后立刻改为进行中文案");
    pclick(p("btnPrepare"));
    pclick(p("btnPrepare"));
    await tick(60);
    ok(typeof release === "function", "24c 请求确实被挂起（用例有效）");
    eq(posts, 1, "24c POST 未返回时连点不会重复提交");
    release();
    await tick(60);
    eq(posts, 1, "24c 请求返回后也没有多余请求");
    // 请求已返回、历史行按钮还没重绘时再点一次，也应被进行中守卫拦下
    const staleRowBtn = actOf(rowOf(p("sessionsList"), "测试会话"), "prepare");
    pclick(staleRowBtn);
    await tick(60);
    eq(posts, 1, "24c 行按钮点到进行中的任务也不会重复提交");
    w.fetch = realFetch;

    // 24d. 立即归档：请求未返回时按钮禁用并显示归档中，返回后复原
    state = makeState({ unarchived: [{ id: "sess_4", sessionId: "sess_4", title: "待归档会话", pendingCompactions: 1, updatedAt: now(), running: false, job: null }] });
    await w.refresh({ silent: true });
    await tick(20);
    const btn4 = actOf(rowOf(p("unarchivedList"), "待归档会话"), "archive");
    ok(!btn4.disabled, "24d 空闲的未归档会话可以立即归档");
    let archivePosts = 0;
    let release4 = null;
    w.fetch = (url, opts = {}) => {
      if (String(url) === "/api/archive") {
        archivePosts += 1;
        return new Promise((res) => { release4 = () => res({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, newCount: 2 }) }); });
      }
      return realFetch(url, opts);
    };
    pclick(btn4);
    eq(archivePosts, 1, "24d 只发出一个归档请求");
    ok(btn4.disabled, "24d 归档请求未返回时按钮禁用（真实点击会被拦下）");
    eq(btn4.textContent, "归档中…", "24d 归档请求未返回时显示归档中");
    release4();
    await tick(80);
    eq(btn4.textContent, "立即归档", "24d 归档结束后按钮文案复原");
    ok(!btn4.disabled, "24d 归档结束后按钮恢复可用");
    w.fetch = realFetch;
    route = () => null;

    busyDom.__guard.assertClean("历史/未归档按钮防重用例");
  }
  busyDom.window.close();

  console.log(`\n通过 ${passes.length} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("\n失败明细：");
    for (const f of failures) console.log("  x " + f);
    process.exitCode = 1;
  }
}

/** 错误收集器自检：故意制造一个未处理异常，验证它确实会被判为"不干净"。
    运行：node smoke.js --guard-selftest */
async function guardSelfTest() {
  const dom = buildDom({ sessionId: "" });
  await tick(40);
  const before = dom.__guard.lines.length;
  dom.window.eval('setTimeout(function () { throw new Error("guard-selftest-boom"); }, 0);');
  await tick(60);
  const caught = dom.__guard.lines.slice(before);
  const detected = caught.length > 0;
  console.log(`错误收集器自检：${detected ? "能捕获未处理异常（符合预期）" : "没捕获到（不符合预期）"}`);
  console.log(`捕获内容：${caught.join(" | ") || "(空)"}`);
  dom.window.close();
  if (!detected) process.exitCode = 1;
}

if (process.argv.includes("--guard-selftest")) {
  guardSelfTest().catch((err) => {
    console.error("自检崩溃：", err);
    process.exitCode = 1;
  });
} else {
  main().catch((err) => {
    console.error("测试崩溃：", err);
    process.exitCode = 1;
  });
}
