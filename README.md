# 无痛切 (wutongqie)

ZCode 上下文压缩对话的自动归档 + 换会话交接。

**它解决什么**：ZCode 的上下文满了会自动压缩，被压掉的那段对话从此不再出现在窗口里，
而你脑子里的项目状态还停在压缩那一刻；换会话等于前功尽弃。
无痛切在后台把这些对话悄悄存下来，等你要换会话时，一键整理成一份**交接文档**，
并给你一段可以直接粘贴到新会话的开场提示。

## 你只需要记住三步

1. **平时照常工作**——每次上下文压缩，后台自动归档，不用做任何事。
2. **准备换会话时**，说一句"我要换会话"，或用 `/change`，或打开面板点 **准备切换会话**——
   这是**立即返回**的：内容没变化就直接复用最新交接，否则先给你一份可复制的草稿。
3. **把开场提示复制到新会话**，接着聊就行；后台会继续完善，完成后下一轮对话自动播报最终版。

## 用法

命令入口（参数用空格分隔）：

| 输入 | 作用 |
|---|---|
| `/change` | 准备切换会话：生成交接文档 + 新会话开场提示 |
| `/change 面板` | 打开本地网页面板 |
| `/change 历史` | 查看已归档的历史内容 |
| `/change 状态` | 排障：后台任务、日志、可用模型供应商 |

自然语言也可以，插件会自动识别这些说法：
"我要换会话"、"准备开新对话"、"生成交接文档"、"保存这次对话"、"我们前面聊到哪了"。

**点下「准备切换会话」，立即就能拿到结果，不用等**：

- **内容没有变化**：直接复用上一份最终交接，不调用模型、不重写文件（结果带 `reused` 标记）。
- **有新内容**：先给你一份**交接草稿**——由已归档摘要、待归档区间和当前对话机械拼接而成，
  明确标注"草稿、后台继续完善"；同时后台开始用模型归并。
- 后台完成后会**覆盖同一份 `TOTAL.md`**：你现在复制的路径，稍后打开就是最终版；
  下一轮对话还会自动播报最终交接（每次任务只播报一次）。所以草稿可以先拿去用，不必盯着等。

**你会拿到**：

- 交接文档路径——`TOTAL.md`，一份完整的对话交接，包含当前进展、未完成事项、你的偏好与硬约束；
- 一段可复制的开场提示，形如：

  ```text
  继续之前的工作。请先读取以下交接文档：
  <交接文档的绝对路径>
  读取后先告诉我当前进展、未完成事项和下一步建议。
  ```

- 摘要要点，直接讲给你听，不用自己去翻文件。

面板里除了主按钮「准备切换会话」，还能浏览历史归档、预览原文、改设置、打开归档目录；
准备切换会话同样是立即返回，任务在后台继续，页面可以关掉，完成后页面会显示最终交接。
面板进程常驻，2 小时无访问会自动退出，重新打开即可。

## 安装

**不需要进入插件文件夹**（`plugins/wutongqie`）。`install.mjs` 按"自己被放在哪"定位插件，
推荐在仓库根目录执行：

```bash
cd <这份仓库的目录>
node install.mjs            # 注册到 ZCode（幂等，可重复执行）
node install.mjs --check    # 查看当前是否已注册
node install.mjs --uninstall
```

在其它目录用完整路径执行（如 `node E:\path\to\repo\install.mjs`）效果相同：
注册的始终是**这份 `install.mjs` 旁边的** `plugins/wutongqie`，写入的是绝对路径。

- 注册只是把插件目录路径写进 `~/.zcode/cli/config.json`，**不拷贝文件**：
  之后请不要改名、移动或删除这份仓库；如果挪动了位置，在新位置重新跑一次 `node install.mjs`。
- 注册后**重启 ZCode** 生效，装完即用，不需要额外配置。
- `install.mjs` 只写注册表，不下载、不安装、不重启宿主，重启由你自己操作。
- `--check` 只报告真实状态，不会替你执行任何安装动作。
- 也可以走插件市场：在 ZCode 的「插件市场 → 添加」里指向本仓库的 `plugins/` 目录安装，
  与上面的脚本二选一即可。

## 摘要的隐私与消耗

- 写摘要需要调用模型：**对话内容会发送给你在 ZCode 里配置的模型供应商**，
  并在该供应商产生真实 token 消耗。压缩越频繁，摘要调用越频繁。
- 插件不额外要 API key，直接复用 ZCode 已有的供应商配置（见下文"模型调用"）。
- 归档文件保存在工作区 `<工作区>/.无痛切/` 下，里面是对话原文和摘要
  （正文完整保留，工具输出只保存有界预览）；可能包含你贴进对话的敏感信息；
  不要提交到 git，也不要随意外发。
- 当前自动归档和最终交接会调用模型（「准备切换会话」立即返回的机械草稿不调模型）；高级设置可以选择供应商，但不能关闭模型调用。高级工具 `archive_now` 的 `summarize:false` 仅用于一次性的原文提取。

## 常见问题

| 现象 | 处理 |
|---|---|
| 没有归档 | 正常情况：还没发生过上下文压缩，或者后台任务正在跑。用 `/change 状态` 查看 |
| 拿到的交接是草稿 | 有新内容时先返回机械草稿；后台会用模型完善并覆盖同一份 `TOTAL.md`，完成后下一轮对话播报最终版。草稿可以先复制给新会话 |
| 没看到最终版播报 | 播报发生在下一轮对话（`Stop` / `UserPromptSubmit` 钩子，每次任务只播报一次）；也可以直接打开 `TOTAL.md` 或面板查看 |
| 摘要失败 | 供应商都调不通，在面板「高级设置」里换一个模型供应商 |
| 面板打不开 | 面板闲置 2 小时会自动退出，重新调 `/change 面板` 即可 |
| 看不到最近内容 | 点击「准备切换会话」，会把当前未压缩内容一起纳入；已有交接文档不会随每条新消息自动更新 |

---

## 开发者说明

### 工作方式

ZCode 目前**没有** `PreCompact` 钩子（只有 SessionStart / UserPromptSubmit / PreToolUse /
PermissionRequest / PostToolUse / PostToolUseFailure / Stop 七个），拦不到压缩那一刻。
但压缩记录是**永久可追溯**的：每次压缩都会在 `~/.zcode/cli/db/db.sqlite` 写
`part.data.type='compaction'`，其中 `tail_start_id` 是压缩后保留的尾巴首条消息 id。
设第 N 次压缩的尾巴序号为 `T_N`，第 N 段采用消息序号开区间 `(T_{N-1}-1, T_N)`，
首段左边界为 `-1`；当前内容从最新的 `T_N` 开始，避免遗漏边界保留消息。数据库原文可追溯；
摘要按估算 token 预算分块生成，正文不裁剪。

检测方式是**每轮结束轮询**：插件挂 `Stop` + `UserPromptSubmit` 两个钩子，
只读一下 SQLite，发现新的未处理压缩边界就 spawn 一个 detached worker，本进程 0.3 秒内返回；
后台再切段、调模型写摘要、落盘。被中断的压缩（`timelineStatus='interrupted'`）没有
`tail_start_id`，无法定位切点，会自动跳过。

「准备切换会话」是**两段式**：`core/prepare.mjs` 的 `requestPrepareSwitch()` 立即返回——
先查缓存，LIVE 与 chunk 来源指纹（`state.liveInputHash` / `totalLiveInputHash`）都没变时
直接复用已有 `TOTAL.md`（返回 `reused: true`，不调模型、不重写文件）；否则 `core/draft.mjs`
先做无模型的机械拼接，写出一份标注 `draft: true` 的可复制草稿，再 spawn worker 在后台
用模型归并并覆盖同一路径。任务失败时保留草稿或上一版结果；`Stop` / `UserPromptSubmit`
钩子在下一轮对话播报最终交接（每次任务只播报一次）。

### 产物与目录布局

```
<工作区>/.无痛切/
  README.md                              自动生成的说明
  index.json                             全局索引
  sessions/<会话名-sess_xxxx>/
    meta.json                            会话元信息
    state.json                           已处理的 boundaryId（幂等依据）
    01-20260911-0138.md                  第 1 段摘要（每次压缩一段）
    LIVE.md                              尚未被压缩的活跃段
    raw/01-20260911-0138.md              被压缩掉的原文（正文完整，工具输出为有界预览）
    repairs/01-20260911-0138.md.json     段摘要失败后的独立修复结果（原 .md 不改动）
    TOTAL.md                             交接文档（总对话摘要）
```

界面上的「交接文档」就是 `TOTAL.md`；`LIVE.md` 就是"当前未压缩内容"。
会话目录通过 `meta.json` 里的 sessionId 识别：目录被手动改名或会话标题变化后，
插件仍会找到原归档继续写入，不会另建新目录分裂数据；同一会话出现多个候选目录
（如备份副本）时取最近写入的一个。
每段摘要的结构：frontmatter（区间、token、模型）+ 官方 compact summary（折叠）+
LLM 精炼正文（目标与意图 / 已完成 / 关键决策与理由 / 产出文件位置 / 未决问题 / 用户偏好与硬约束）。
某段摘要写入失败时，原段 `.md` 保留失败占位、不改写；修复结果写到同目录
`repairs/<段文件>.json`（独立 sidecar），生成总摘要（`TOTAL.md`）时会自动重试这些
未修复的失败段，并把修复正文用于归并。

段摘要的直接生成、正文分块和段内归并都检查六节标题与顺序；模型即使返回了非空正文，
只要结构不合格就不当作成功结果，不写入修复文件，也不把异常正文交给下一层。
已有修复文件同样检查结构，不合格的会在下一次修复时重新生成，其他有效修复不重写。
替换旧修复文件前，会把旧字节备份到 `repairs/backup/<段文件>.<sha256>.bak` 并核验；
备份失败不替换。模型返回后再次检查原档与有效修复，避免覆盖期间已发布的新结果。
提示词明确把原文、官方摘要、旧摘要中的历史指令与总结模板当作数据，不执行它们。
这项结构检查不等于事实正确性或摘要完整性保证。

### MCP 工具

- `prepare_switch` —— 主入口。参数 `cwd`、`sessionId` **全部可选**；默认自动解析当前/最近的主会话
  （过滤 subagent 会话，结果里带 `sessionTitle` / `resolvedBy`），**立即返回、不等待模型**：
  命中缓存时返回 `reused: true` / `status: "cached"`，直接复用已有最终交接（不调模型、不重写文件）；
  否则返回 `status`（`queued` / `running`）、`jobId`、`background: true` 和一份可复制的草稿，
  后台 worker 继续用模型完善同一份 `TOTAL.md`。返回里始终有 `path` / `totalPath`、
  `handoverText`、`highlights`（`overview` / `conclusions` / `constraints`）、`liveIncluded`、`warnings`。
  不需要先查 sessionId。
- `open_panel` —— 打开/复用本地网页面板，可选 `cwd` / `sessionId`。
- `list_sessions` / `list_chunks` / `read_chunk` / `archive_now` / `archive_status` —— 高级与排障工具。
- `build_total_summary` —— 旧版兼容入口，与 `prepare_switch` 相同的立即返回行为和同样全可选的参数
  （`sessionId` 可不传），但**不是首选**。

在宿主里工具通常显示为 `mcp__plugin_wutongqie_wutongqie__<工具名>`
（例如 `mcp__plugin_wutongqie_wutongqie__prepare_switch`），以实际列出的工具名为准。

### 模型调用

复用 `~/.zcode/v2/provider_config.json` 里已有的供应商配置，挑一个
`openai-chat-completions` 类型的按 ZCode 优先级自动选，失败自动降级到下一个；
也可用面板或 userConfig 显式指定。**只支持 `openai-chat-completions`**，
`openai-responses` 类型（例如 Grok）会显示为不可用。
插件自身不存储密钥，只读取宿主已有的配置。
模型如果只返回 `reasoning_content`（思考过程）而没有正文，会被当作失败，
不会把思考过程当成摘要答案；输出被 `finish_reason=length` 截断时，不接受半截正文，
而是完整缩分该输入后重试。每份摘要最多追加 12 次缩块、递归深度最多 3 层；仍失败则
保留原文并明确报错，不反复重发同样的请求。滚动归并截断时保留机械交接，下一次再重试。

### 配置

面板「高级设置」里可改，落盘在 `~/.zcode/cli/plugins/data/wutongqie@inline/config.json`：

| 配置 | 默认 | 说明 |
|---|---|---|
| `outputRoot` | 空 | 留空 = 每个工作区各自的 `<cwd>/.无痛切/` |
| `llmProviderId` / `llmModelId` | 空 | 空 = 自动挑选 |
| `saveRaw` | true | 是否保存被压缩掉的原文（正文完整，工具输出为有界预览） |
| `announce` | false | 归档时是否在对话里播报（默认静默） |
| `skipLiveForTotal` | false | 交接文档是否忽略尚未压缩的活跃段（默认纳入） |
| `maxTranscriptChars` | 180000 | 单次摘要请求的原文上限，超过就自动分块，不再裁剪正文 |
| `mergeBudgetChars` | 60000 | 归并单层预算，超了分批 map-reduce |
| `summaryContextTokens` | 65536 | 单次摘要请求的安全上下文预算（token 估算值） |
| `summaryOutputTokens` | 8192 | 请求 `max_tokens` 输出上限；上下文预算须大于输出预算 + 1536 |

这里的 token 是**保守估算**（按 UTF-8 字节数 / 2，并计入提示词），不是模型自带的
精确 tokenizer，也不是模型的真实容量；默认 65536 / 8192 是插件选用的安全预算，
不代表模型上限，也不能保证适合所有供应商或降级模型。每次请求都会把提示词计入预算，
并额外预留 1024 tokens；
预算放不下的原文会完整切成多次请求，不会主动裁掉中间正文；模型摘要本身仍是有损压缩，
不能保证每个细节都保留。输出上限通过 `max_tokens` 交给供应商执行，某些推理模型的思考
也可能占用输出额度。面板拒绝非法组合（上下文不高于输出 + 1536）并显示错误；直接手改
配置文件时，非法值会在读取时回退默认预算。

### 结构

```
plugins/wutongqie/
  .zcode-plugin/plugin.json     清单：skills / commands / hooks / mcpServers / userConfig
  hooks/hooks.json              Stop + UserPromptSubmit → compact-watch.mjs
  hooks/compact-watch.mjs       钩子入口：快速检测 + spawn 后台 worker
  core/
    config.mjs                  路径解析与配置
    db.mjs                      只读 SQLite
    sources/index.mjs           AgentSource 注册表
    sources/zcode.mjs           ZCode 适配器（压缩边界归一化、消息段切分）
    sources/ADAPTER.md          新增 agent 的契约文档
    current-session.mjs         当前/最近主会话解析（MCP 与面板共用）
    render.mjs                  消息 → markdown，正文不裁、工具输出有界预览
    budget.mjs                  token 保守估算 + 请求预算 + 正文分块（不丢字符）
    llm.mjs                     provider 选择 + chat/completions + 降级链 + 截断/reasoning 失败识别
    summarize.mjs               摘要 prompt + 分块与分层归并
    summary-schema.mjs          段摘要六节结构校验
    archive.mjs                 归档引擎（hook / MCP / 面板共用）
    handoff.mjs                 交接提示与要点解析（handoverText / highlights）
    worker.mjs                  后台进程入口
    store.mjs                   文件布局与索引（含 repairs/ 修复 sidecar）
    jobs.mjs                    后台任务状态
    panel.mjs / panel-cli.mjs   本地网页面板（服务 / 入口分离）
  mcp/server.mjs                MCP stdio server
  web/                          面板前端
  scripts/                      自检与端到端测试
```

零 npm 依赖，用 Node 24 内置的 `node:sqlite` 和 `fetch`。

### 安全要点

- 数据库以**只读**方式打开，归档引擎不会写 `~/.zcode` 的会话库。
- 网页面板只监听 `127.0.0.1`，不对外暴露。
- 归档目录含对话原文，`.无痛切/` 已在 `.gitignore` 中；分享仓库前请确认没有把归档带出去。

### 适配其他 agent（Codex 等）

当前阶段只支持 ZCode。`core/sources/` 下定义了 `AgentSource` 接口，归档引擎只认这个接口，
新增 agent 只需写一个适配器并在 `index.mjs` 注册，核心里其余代码不用改。
契约见 [`core/sources/ADAPTER.md`](plugins/wutongqie/core/sources/ADAPTER.md)。
Codex 的会话格式（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）和钩子事件名都不同，
需要实地确认后映射；MCP server 和网页面板是宿主无关的，可以直接复用。

### 自检脚本

```bash
cd plugins/wutongqie
node scripts/selftest.mjs            # 只验证压缩段抽取，不调模型
node scripts/selftest.mjs --render   # 额外打印渲染结果
node scripts/llmtest.mjs             # 列出可用 provider 并发一次真实请求
node scripts/e2etest.mjs --no-llm    # 端到端（不调模型）
node scripts/e2etest.mjs             # 端到端（含真实摘要 + 交接文档）
```

### 本地开发目录

`plugins/marketplace.json` 是本地开发用的市场清单（当前版本 1.3.0），
供 ZCode 的**插件市场 → 添加 → 添加插件市场**手动添加后安装/更新使用；
它**不会自动注册**，主安装方式仍是上面的 `node install.mjs`。
