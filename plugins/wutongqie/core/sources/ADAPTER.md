# AgentSource 适配器契约

归档引擎（`core/archive.mjs`）只认下面这个接口。要让插件支持新的 agent
（Codex、Claude Code、其他），写一个实现并到 `core/sources/index.mjs` 里注册即可，**其余代码不用动**。

## 接口

```js
{
  id: 'codex',              // 唯一标识
  name: 'Codex',            // 展示名
  default: false,           // 只有一个实现可以置 true，作为缺省源

  // 列出工作区下的主会话，最新的在前
  listSessions({ cwd, limit }) -> Array<{
    id, title, cwd, createdAt, updatedAt   // ISO 字符串
  }>

  getSession(sessionId) -> { id, title, slug, cwd, createdAt, updatedAt } | null

  // 该会话最后一条消息的序号，用来切"仍留在上下文里的活跃尾巴"
  maxSequence(sessionId) -> number

  // 已完成的所有上下文压缩，按时间升序
  listCompactions(sessionId) -> Array<{
    boundaryId,            // 唯一且稳定，用作幂等键
    time,                  // ISO，完成时间
    startedAt,             // ISO，开始时间
    trigger,               // 'auto' | 'manual' | ...
    phase,                 // 实现自定义，如 'pre_request' | 'mid_turn'
    compactReason,         // 如 'context_limit'
    preCompactTokenCount,  // 压缩前 token（可为 null）
    postCompactTokenCount,
    summarizedMessageCount,
    keptMessageCount,
    tailMessageId,         // 压缩后保留下来的尾巴首条消息 id
    tailSequence,          // 该消息的序号；引擎靠它定位切点
    summaryMessageIds,     // 压缩产出的摘要消息 id
    officialSummary,       // 摘要正文（markdown，可为 null）
  }>

  // 取 sequence 开区间 (fromSeq, toSeq) 内的对话消息；fromSeq = -1 表示从会话开头
  getSegment(sessionId, fromSeq, toSeq) -> {
    messages: Array<{
      id, sequence,        // number
      time,                // epoch 毫秒
      role,                // 'user' | 'assistant'
      kind,                // 实现自定义类别
      special,             // null | 'official-summary'
      title, text,         // 仅 special === 'official-summary' 时有
      parts: Array<{ sequence, data }>,
    }>,
    stats: { fromSeq, toSeq, totalRows, userCount, assistantCount, toolCount, hiddenRows },
  }
}
```

## 引擎如何切段

设第 N 次压缩的尾巴序号为 `T_N`，则第 N 段 = `(T_{N-1}-1, T_N)` 开区间；首段左边界为 `-1`。保留的首条消息 `T_N` 会出现在下一段或当前活跃内容中。
`listCompactions` 里**没有 `tailSequence` 的项会被直接丢弃**——它们无法定位切点（ZCode 里对应被中断的压缩）。
最后一次压缩之后的活跃尾巴单独作为 `LIVE` 段处理，由 `maxSequence` 定位。

幂等完全依赖 `state.json` 里记录的已处理 `boundaryId` 列表，所以 `boundaryId` 必须稳定且唯一。

## 加一个 Codex 适配器还需要什么

Codex 的会话存在 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（每行一个 JSON 事件），
压缩事件在里面的表示形式和钩子事件名都与 ZCode 不同，需要实地确认后映射到上面这套字段。
另外 Codex 的插件清单是 `.codex-plugin/plugin.json`，钩子文件也独立，
把 `hooks/hooks.json` 复制成 `hooks/hooks.codex.json` 并改成 Codex 的事件名即可。
MCP server 和网页面板是宿主无关的，可以直接复用。
