# Compaction 机制说明（Pomelobot）

> 本文档说明 Pomelobot 的上下文压缩机制、触发策略、执行流程与运维建议。

参考：
- [OpenClaw Compaction](https://docs.openclaw.ai/zh-CN/concepts/compaction)
- [Memory + Compaction 流程图](./architecture-memory-compaction.md)

---

## 1. 什么是 Compaction

Compaction 的目标是：
- 在有限 context window 内保持对话连续性
- 减少历史消息对上下文预算的占用
- 保留关键决策/约束/待办，丢弃低价值细节

在 Pomelobot 里，Compaction 与 Memory 不是替代关系，而是串联关系：
- 先 `memory flush`（尽量把关键事实写入记忆）
- 再压缩当前会话消息历史

---

## 2. 触发时机

### 2.1 自动触发（CLI + DingTalk）

系统维护 `flushState.totalTokens`（启发式 token 估算），并按以下阈值执行：

1. `memory flush` 阈值
- `totalTokens >= auto_compact_threshold * 0.9`
- 用于提前写入记忆，降低压缩时信息丢失风险。

2. `compaction` 阈值
- `totalTokens >= auto_compact_threshold`
- 触发会话压缩。

### 2.2 手动触发（CLI）

CLI 支持：
- `/compact [说明]`

可传“压缩重点说明”，系统会把它作为摘要附加指令，影响摘要内容侧重。

> DingTalk 目前没有 `/compact` 命令入口，主要依赖自动触发。

---

## 3. 执行流程

### 3.1 高层流程

```
收到消息 / 准备回复
  |
  |-- updateTokenCount()
  |-- shouldTriggerMemoryFlush() ? -> executeMemoryFlush(preserveTokenCount=true)
  |-- shouldAutoCompact() ?
  |     \-- compactMessages()
  |           |- summarize old messages
  |           |- keep recent messages
  |           \- rebuild session message history
  \-- 继续正常推理与回复
```

### 3.2 摘要压缩算法（当前实现）

`compactMessages(messages, model, maxTokens)` 的核心逻辑：

1. 计算 `tokensBefore`
2. 若未超预算，直接返回
3. 拆分 `system`、已有 compaction 摘要、`conversation` 消息
4. 预算分配
- `availableForConversation = maxTokens - systemTokens - 500`
- 其中最近消息目标保留约 `60%` 会话预算
5. 将“已有摘要 + 本轮需压缩旧消息”一起交给 LLM，生成新的统一摘要（`generateSummary`）
6. 生成新历史：`system + [对话历史摘要] + recent`

当前摘要会强制输出固定结构，重点保留“进行中工作态”：
- `## 当前任务`
- `## 最新用户请求`
- `## 已完成进展`
- `## 进行中工作`
- `## 待办与后续承诺`
- `## 关键决策与约束`
- `## 未解决问题与风险`

注意：
- 若会话已经压缩过，旧的 `[对话历史摘要]` 不会继续堆叠保留。
- 新一轮 compaction 会把旧摘要与旧消息合并成**一条新的统一摘要**，避免多次压缩后出现多条历史摘要串联。

输出：
- `messages`
- `summary`
- `tokensBefore`
- `tokensAfter`

### 3.3 DingTalk 特有行为

- compaction 完成后，摘要会写入 `dingtalk_session_events`（role=`summary`）。
- 每轮结束 session 状态会 UPSERT 到 `dingtalk_sessions`。
- 进程收到 `SIGINT/SIGTERM` 时会尝试关机前 flush 活跃会话，降低重启丢失概率。

---

## 4. 上下文窗口与预算

当前 compaction 预算主要来自：
- `maxTokens = context_window * max_history_share`

示例（默认值）：
- `context_window=128000`
- `max_history_share=0.5`
- compaction 预算约 `64000`

注意：
- `reserve_tokens` 字段当前主要是配置层保留字段，尚未进入 compaction 预算计算主路径。

---

## 5. 与 Memory 的关系

### 5.1 为什么先 flush 再压缩

若直接压缩，可能把“尚未结构化存档”的关键事实只留在摘要中。

因此当前策略是：
1. 先通过 memory flush 尝试强制 `memory_save`
2. 再 compaction 会话历史

### 5.2 压缩后还能不能追溯

可以，但要区分两种来源：
- 知识型记忆：`memory_search`（chunks + session events）+ `memory_get`（按路径精读）
- 会话态恢复：`dingtalk_sessions` / `dingtalk_session_events`

---

## 6. 配置速查

```jsonc
{
  "agent": {
    "compaction": {
      "enabled": true,
      "auto_compact_threshold": 80000,
      "context_window": 128000,
      "reserve_tokens": 20000,
      "max_history_share": 0.5
    }
  }
}
```

字段说明：
- `enabled`：是否开启自动压缩
- `auto_compact_threshold`：自动压缩阈值
- `context_window`：上下文窗口预算
- `reserve_tokens`：预留字段（当前未完全用于 compaction 主预算）
- `max_history_share`：压缩后允许历史占用比例

---

## 7. 观测与排障

### 7.1 CLI 可观测点

- `/status`：查看 context 占用、compaction 次数、阈值
- `/compact`：手动验证压缩路径

### 7.2 DingTalk 可观测点

关注日志关键字：
- `Executing memory flush`
- `Auto-compacting context`
- `Compaction completed`
- `Shutdown memory flush summary`

### 7.3 常见问题

1. 触发太频繁
- 调高 `auto_compact_threshold`
- 或降低每轮无效冗长输出

2. 压缩后信息丢失感明显
- 在 `/compact` 增加更明确“保留重点”说明
- 提高 `max_history_share`
- 优化 memory flush 提示词与记忆落库质量

3. 重启后仍感觉“断片”
- 确认是 SIGTERM 优雅退出，而非 SIGKILL
- 检查 PG 可达性与 session 表写入情况

---

## 8. 与 OpenClaw 的差异与优劣

### 8.1 机制差异

1. 触发理念
- OpenClaw：文档强调根据上下文窗口安全比例自动触发，并区分 compaction 与 session pruning。
- Pomelobot：采用双阈值（90% flush + 100% compact）与固定预算比例（`context_window * max_history_share`）。

2. 模式能力
- OpenClaw：文档明确“压缩配置与模式（modes）”与 pruning 关系。
- Pomelobot：当前是单一路径摘要压缩，pruning 模式尚未单独产品化。

3. Memory 耦合方式
- OpenClaw：强调 compaction 与 memory 协同，但概念上分层更明确。
- Pomelobot：工程上强绑定“flush-before-compact”，在实战里更直接，但策略颗粒度较粗。

### 8.2 优劣对比

Pomelobot 的优势：
- 行为简单直接，调参成本低。
- 与 DingTalk 场景整合深（summary 事件入库、关机前 flush）。
- 在“容易重启/滚动发布”的场景，落盘保障更务实。

Pomelobot 的短板：
- 缺少 compaction mode/pruning mode 的细粒度策略开关。
- `reserve_tokens` 尚未完整进入预算算法，策略表达力不足。
- token 估算是启发式，不是 provider 真实计费 token，存在偏差。

OpenClaw 的优势（从文档设计看）：
- compaction 与 pruning 分层清晰，可解释性强。
- 上下文窗口管理与模式化策略更完整。

OpenClaw 的潜在代价：
- 模式更丰富也意味着配置与调优复杂度更高。

---

## 9. 后续优化建议（面向你当前项目）

1. 增加 compaction mode
- `summary_only` / `summary_plus_prune` / `prune_only`

2. 让 `reserve_tokens` 生效
- 将 `maxTokens` 改为 `context_window - reserve_tokens` 与 `max_history_share` 联合约束

3. 引入真实 token 计数器
- 对接当前 active model provider 的 tokenizer，替换启发式估算

4. 为 DingTalk 增加手动压缩入口
- 支持 `/compact`（可选仅管理员可用）
