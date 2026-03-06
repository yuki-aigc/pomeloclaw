# 上下文文件与优先级

本文档说明 `AGENTS.md`、`TOOLS.md`、`SOUL.md`、`HEARTBEAT.md`、`MEMORY.md` 在 Pomelobot 中的作用、加载方式、scope 覆盖规则，以及冲突时的优先级。

## 1. 总览

| 文件 | 主要作用 | 默认位置 | 是否支持 scope 覆盖 |
|------|----------|----------|---------------------|
| `AGENTS.md` | 项目协作规范、执行边界、团队规则 | `workspace/AGENTS.md` | 否 |
| `TOOLS.md` | 工具选择与调用约定 | `workspace/TOOLS.md` | 是 |
| `SOUL.md` | 身份、语气、风格偏好 | `workspace/SOUL.md` | 是 |
| `HEARTBEAT.md` | 纠错复盘、行为修正经验 | `workspace/HEARTBEAT.md` | 是 |
| `MEMORY.md` | 长期记忆与事实背景 | `workspace/MEMORY.md` | 主文件否；隔离 scope 使用独立长期记忆文件 |

补充说明：
- `AGENTS.md` 缺失时，会回退尝试 `workspace/AGENT.md`。
- `MEMORY.md` 不属于 Prompt Bootstrap 文件集合，它和前四者的用途不同。

## 2. 每个文件应该写什么

### 2.1 `AGENTS.md`

用于放项目级的执行规范，例如：
- 代码协作约定
- 提交或评审规则
- 不允许做的操作
- 需要优先遵循的工程要求

建议内容偏“规则”，不要写成零散事实备忘。

### 2.2 `TOOLS.md`

用于约束“怎么用工具”，例如：
- 优先使用哪些工具
- 某些命令或 API 的调用顺序
- 文件生成后应该写到哪里
- 某个渠道下应该优先用哪个 file-return tool

建议内容偏“操作约定”，不要混入人格风格。

### 2.3 `SOUL.md`

用于定义助手的角色和表达风格，例如：
- 语气偏直接还是偏解释型
- 应该强调哪些价值观
- 面对用户时的表达边界

建议内容偏“人格与表达”，不要放硬安全规则。

### 2.4 `HEARTBEAT.md`

用于记录经过验证的纠错经验，例如：
- 过去在哪类场景犯过错
- 应该如何修正
- 以后如何避免回归

建议内容偏“纠偏经验库”。只有真实纠错价值的内容才应该写入。

### 2.5 `MEMORY.md`

用于存放长期记忆和事实背景，例如：
- 用户长期偏好
- 项目长期背景信息
- 长期有效的约束和已确认事实

它更像“可检索事实背景”，不是行为规则文件。

## 3. 加载时机

### 3.1 Prompt Bootstrap 文件

以下文件属于 Prompt Bootstrap：
- `AGENTS.md`
- `TOOLS.md`
- `SOUL.md`
- `HEARTBEAT.md`

加载特点：
- 在同一个 `thread_id` 的首轮调用时注入。
- 后续同一线程不会每轮重复注入。
- 仅 Agent 重建不会让已注入过的旧线程自动重新读取这些文件。
- 如果你修改了这些文件并希望立即生效，需要让后续请求进入新的 `thread_id`。

### 3.2 `MEMORY.md`

`MEMORY.md` 不走 Prompt Bootstrap 这条链路。

当前实现里：
- System Prompt 中只注入“如何正确使用记忆工具”的规则提示，不会把 `MEMORY.md` 全量塞进上下文。
- 需要回溯历史事实时，应优先使用 `memory_search`，必要时再用 `memory_get` 精读。
- `memory_get` 支持直接读取 `MEMORY.md`、`memory/**/*.md`、`HEARTBEAT.md` 与 `session_events/...` 路径。

这意味着：
- `MEMORY.md` 是事实来源。
- `AGENTS.md`、`TOOLS.md`、`SOUL.md`、`HEARTBEAT.md` 是行为约束或风格约束。

## 4. Scope 覆盖规则

### 4.1 支持覆盖的文件

以下文件支持 scope 级覆盖：
- `TOOLS.md`
- `SOUL.md`
- `HEARTBEAT.md`

覆盖路径为：

```text
workspace/memory/scopes/<scope>/TOOLS.md
workspace/memory/scopes/<scope>/SOUL.md
workspace/memory/scopes/<scope>/HEARTBEAT.md
```

选择顺序：
1. 如果存在 scope 文件，优先读取 scope 文件。
2. 否则回退到 `workspace/` 根目录下的全局文件。

### 4.2 不支持覆盖的文件

- `AGENTS.md` 只读取全局文件，不支持 scope 版本。
- `MEMORY.md` 主文件也是全局根文件；隔离 scope 的长期记忆会写到独立文件，而不是 `workspace/memory/scopes/<scope>/MEMORY.md`。

当前隔离 scope 的长期记忆文件通常位于：

```text
workspace/memory/scopes/<scope>/LONG_TERM.md
```

## 5. 优先级

行为规则冲突时，系统按以下优先级处理，数字越小优先级越高：

1. 平台与运行时硬约束
2. 系统提示词硬规则
3. 用户当前任务目标与明确约束
4. `AGENTS.md`
5. `TOOLS.md`
6. `SOUL.md`
7. `HEARTBEAT.md`

进一步说明：
- scope 级 `TOOLS.md` / `SOUL.md` / `HEARTBEAT.md` 只是在各自层级内覆盖全局文件，不会提升层级。
- 例如，scope 下的 `SOUL.md` 仍然低于全局 `TOOLS.md`。
- `HEARTBEAT.md` 用于纠偏，不应该推翻更高层级的硬规则。

## 6. `MEMORY.md` 在优先级中的位置

`MEMORY.md` 不参与上面第 4 到第 7 层的规则排序。

更准确地说：
- 它提供事实性上下文和长期记忆。
- 当 `MEMORY.md` 中的内容和用户当前明确要求冲突时，应优先执行当前用户任务。
- 当 `MEMORY.md` 中的内容和安全约束冲突时，应优先执行安全约束。
- 当需要精确引用时，不应仅凭印象复述，而应通过 `memory_search` + `memory_get` 取证。

因此，`MEMORY.md` 更像知识源，而不是行为控制层。

## 7. 写作建议

推荐按下面方式分工：
- `AGENTS.md` 写团队硬约定。
- `TOOLS.md` 写工具与渠道使用习惯。
- `SOUL.md` 写表达风格与角色边界。
- `HEARTBEAT.md` 写纠错经验与防回归检查。
- `MEMORY.md` 写长期事实、偏好、背景信息。

不推荐：
- 在 `SOUL.md` 里写命令白名单。
- 在 `MEMORY.md` 里写“永远不要做某事”这类硬规则。
- 在 `HEARTBEAT.md` 里保存没有验证价值的泛泛总结。

## 8. 一个最小示例

```text
workspace/
├── AGENTS.md
├── TOOLS.md
├── SOUL.md
├── HEARTBEAT.md
├── MEMORY.md
└── memory/
    └── scopes/
        └── group_ops/
            ├── TOOLS.md
            ├── SOUL.md
            ├── HEARTBEAT.md
            └── LONG_TERM.md
```

在这个例子里：
- 所有会话都读全局 `AGENTS.md`。
- `group_ops` scope 会优先使用自己的 `TOOLS.md`、`SOUL.md`、`HEARTBEAT.md`。
- `group_ops` 的长期记忆读写落在 `LONG_TERM.md`，不会覆盖全局 `MEMORY.md`。
