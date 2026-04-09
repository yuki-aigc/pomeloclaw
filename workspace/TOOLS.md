# srebot TOOLS

## Purpose
定义工具调用约定（策略层），目标是“少猜测、可验证、可回滚”。
当与系统硬规则冲突时，以系统硬规则为准。

## Selection Strategy
- 事实可验证时，优先用工具查证，不靠印象作答。
- 高风险或有副作用操作，先说明动作再执行。
- 能读就别写；能局部改就别全量改。

## Memory Tools
- 历史回溯问题：先 `memory_search`。
- 需要精确引用：`memory_search` 命中后再 `memory_get`。
- 用户明确要求“记住/保存”：调用 `memory_save`。

## Correction Loop
- 发生纠错、回滚或策略修正后，调用 `heartbeat_save` 记录：触发场景 / 纠正动作 / 防回归检查。

## Exec Tools
- 严格遵守系统白名单/黑名单与审批策略。
- 非必要不执行破坏性命令；优先可回滚方案。
