# 多 Agent / 多 Session 设计（srebot）

> 本文档定义 srebot 的多 agent 演进方向。目标是把当前“单主 agent + 轻量 subagent”的结构，升级为“通用协作框架 + 可插拔专家包”，同时保持当前项目的渠道、记忆、MCP、审批、审计能力不被破坏。

参考：
- [渠道网关设计](./channel-gateway.md)
- [Memory 机制说明](./memory.md)
- [上下文文件与优先级](./context-files.md)

---

## 1. 背景与问题

当前 srebot 更接近“单 agent 多会话”：

- 对外只有一个主 agent。
- 会话连续性主要依赖 `thread_id` 与 `conversationId`。
- `subagents/` 目前只用于轻量内部委托，例如技能编写助手。
- `memory` 的隔离维度主要是 `main / direct / group`，而不是“专家角色”。

这套结构对单人助手、单角色协作足够，但对“团队级 Agent 助手”存在 4 个明显不足：

1. 角色边界不清
- 告警处置、成本治理、漏洞修复、交付流水线问题都由同一个 system prompt 承担，容易把工具能力、工作流约束、口径风格混在一起。

2. 权限隔离不足
- 当前工具是按主 agent 注入，不适合表达“某个专家只能读集群、另一个专家允许生成修复脚本”。

3. 协作对象不可寻址
- 现在没有“向另一个专家 session 发任务”“拉起并行子任务”“把结果异步推回父会话”的正式机制。

4. 场景扩展容易硬编码
- 如果直接把 `alert-triage`、`cost-optimizer` 之类角色写死在代码里，项目就会被锁定成 SRE 专用产品。

因此，多 agent 的核心目标不是“多几个 prompt”，而是引入一层通用协作运行时。

---

## 2. 设计目标

### 2.1 核心目标

1. 框架通用化
- 多 agent 能力本身不绑定 SRE，可以承载团队助手、研发助手、运营助手等不同场景。

2. 专家可配置
- 具体专家通过配置声明，而不是硬编码在运行时代码中。

3. Session 可寻址
- 专家之间可以显式 handoff、spawn、回传结果，而不是只能靠同一上下文里的 prompt 协作。

4. 权限与记忆可隔离
- 每个专家可有独立的工具集合、模型偏好、记忆策略和允许协作对象。

5. 渐进落地
- 第一阶段不推翻当前 `createDeepAgent`、Gateway、Memory、Cron、MCP 结构，只在其上增加协作层。

### 2.2 非目标

1. 不在第一阶段引入“每个专家一个外部渠道账号”。
2. 不在第一阶段复制 智能体 的全部 A2A ping-pong 机制。
3. 不在第一阶段把现有单 agent 能力全部拆散重写。

---

## 3. 设计原则

### 3.1 框架层与场景层分离

- 框架层负责：
  - agent profile 注册
  - session key 规范
  - handoff / spawn / completion event
  - 任务注册表
  - 权限与记忆边界
- 场景层负责：
  - SRE 专家 pack
  - 研发专家 pack
  - 其他垂直团队 pack

### 3.2 Commander + Specialists

- 对外只有一个主入口 agent，称为 `commander`。
- commander 负责接收用户请求、判断复杂度、拆分任务、汇总结果。
- specialist 负责完成某个明确任务，不直接承担团队对话总控责任。

### 3.3 Push 优先，不轮询

- 子任务完成后，结果应以内部事件方式推回父 session。
- 避免父 agent 通过循环调用 `list` 或 `history` 去忙等结果。

### 3.4 专家是“运行时对象”，不是“提示词片段”

- 一个专家至少应有：
  - 明确身份
  - 独立配置
  - 独立协作边界
  - 可追踪 session
  - 生命周期状态

---

## 4. 当前能力与演进判断

当前项目已具备以下可复用基础：

1. 单 agent 运行时
- 现有 `createDeepAgent(...)`、`ConversationRuntime`、多渠道接入都能继续复用。

2. 会话隔离
- 已有 `thread_id`、`conversationId`、`session_events`、transcript、scope 隔离能力。

3. 工具系统
- 已有 memory、exec、cron、MCP、文件回传等能力，可作为专家工具池来源。

4. 渠道路由
- `GatewayService + ChannelAdapter` 已形成统一入口。

真正缺失的是“专家协作控制层”：

- 没有专家注册表。
- 没有跨 session handoff / spawn。
- 没有任务注册表。
- 没有 completion event 注入。
- 没有专家级工具/记忆/模型策略。

---

## 5. 总体架构

建议引入 4 个新概念：

1. `AgentProfile`
- 描述一个专家的静态能力。

2. `AgentRegistry`
- 管理所有已注册 profile，并支持按场景加载 pack。

3. `CollaborationSession`
- 表示一次专家协作单元，可是主会话、incident 会话或子任务会话。

4. `TaskRegistry`
- 跟踪父任务与子任务、状态、完成时间、结果摘要、重试信息。

推荐的逻辑结构：

```text
Inbound Message
   -> GatewayService
   -> Commander Profile Resolution
   -> Commander Session
   -> Decide:
      - reply directly
      - handoff to another expert session
      - spawn 1..N specialist task sessions
   -> specialists run with own tool/memory/model policy
   -> task_completion internal event pushed back
   -> commander synthesizes final reply
```

---

## 6. AgentProfile 设计

### 6.1 目标

把“专家”从代码常量变成声明式配置。

### 6.2 建议结构

```ts
interface AgentProfile {
  id: string;
  name: string;
  description: string;
  category?: string;
  role: "commander" | "specialist";
  enabled: boolean;

  prompt: {
    baseIdentity?: string;
    promptFiles?: string[];
    bootstrapMode?: "full" | "lightweight" | "none";
  };

  runtime: {
    modelAlias?: string;
    recursionLimit?: number;
    maxChildren?: number;
    allowSpawn?: boolean;
    allowHandoffTo?: string[];
  };

  tools: {
    include?: string[];
    exclude?: string[];
    mcpServers?: string[];
    execPolicy?: "deny" | "readonly" | "approved" | "full";
  };

  memory: {
    mode: "shared" | "isolated" | "hybrid";
    scopePrefix?: string;
    readSharedScopes?: string[];
    writeSharedScopes?: string[];
  };

  routing?: {
    intents?: string[];
    keywords?: string[];
    channels?: string[];
    defaultForPack?: boolean;
  };

  metadata?: Record<string, unknown>;
}
```

### 6.3 关键解释

- `role`
  - `commander` 负责总控。
  - `specialist` 负责专项任务。

- `bootstrapMode`
  - `full`：完整注入 `AGENTS / TOOLS / SOUL / HEARTBEAT`。
  - `lightweight`：只注入必要文件，适合后台任务和子专家。
  - `none`：只依赖 profile 自身提示词。

- `memory.mode`
  - `shared`：共享团队主记忆。
  - `isolated`：独立专家记忆。
  - `hybrid`：读共享、写隔离，或读隔离、写共享，按策略细化。

---

## 7. Pack 设计

### 7.1 为什么要有 pack

如果 profile 只有注册表，没有 pack，很容易重新回到“在配置里散落几十个专家”。

因此建议引入 `AgentPack`：

```ts
interface AgentPack {
  id: string;
  name: string;
  description: string;
  profiles: AgentProfile[];
  defaults?: {
    commanderId?: string;
  };
}
```

### 7.2 含义

- 框架层负责加载 pack。
- SRE 只是第一套 `pack`，不是框架内置唯一场景。

建议初期支持：

- `sre-team`
- `engineering-team`
- `general-team`

---

## 8. Session 模型

### 8.1 问题

当前项目已有会话，但会话主要服务“用户对话连续性”。多 agent 之后，需要同时表达：

- 用户会话
- 专家主会话
- 专家子任务会话
- incident / work item 会话

### 8.2 建议 Session Key

```text
conversation:<channel>:<conversationId>
agent:<profileId>:main
agent:<profileId>:conversation:<channel>:<conversationId>
agent:<profileId>:work:<workType>:<workId>
agent:<profileId>:task:<taskId>
```

### 8.3 各自用途

- `conversation:*`
  - 对外聊天入口标识。

- `agent:<profileId>:conversation:*`
  - 某专家在某个用户会话上的连续上下文。

- `agent:<profileId>:work:*`
  - 围绕 incident、change、cost case 等工作对象建立的持续协作上下文。

- `agent:<profileId>:task:*`
  - 一次后台子任务或短期专项任务。

### 8.4 与现有 thread_id 的关系

- `thread_id` 仍可保留，作为底层 DeepAgents/LangGraph 的执行上下文 id。
- 但业务层应先有 session key，再由 session key 映射到底层 `thread_id`。
- 不能继续让 `thread_id` 直接承担所有业务语义。

---

## 9. 协作协议

### 9.1 必要能力

建议先实现 4 类内部能力：

1. `experts_list`
- 列出当前可用专家及其说明、工具边界、允许 handoff 目标。

2. `sessions_spawn`
- 拉起一个新的 specialist task session。

3. `sessions_send`
- 向一个已有 session 发送新任务或补充信息。

4. `tasks_list` / `tasks_cancel`
- 查看本会话派生任务和取消任务。

### 9.2 handoff 与 spawn 的区别

- `handoff`
  - 把当前问题转交给另一个专家主会话继续处理。
  - 更适合“主责切换”。

- `spawn`
  - 保持当前会话仍为父任务，临时拉起子任务并等待结果回传。
  - 更适合并行分析。

### 9.3 推荐行为

- 简单问题：commander 直接答。
- 明确单专业问题：handoff 给一个专家。
- 复杂跨域问题：spawn 多个专家并行完成，再由 commander 汇总。

---

## 10. TaskRegistry 设计

### 10.1 目标

把专家协作从“隐式 prompt 记忆”变成“可管理任务图”。

### 10.2 建议结构

```ts
interface TaskRecord {
  taskId: string;
  parentSessionKey: string;
  childSessionKey: string;
  profileId: string;
  label: string;
  objective: string;
  status: "accepted" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  resultSummary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

### 10.3 初期要求

1. 能按父 session 查询任务树。
2. 能识别活跃子任务数。
3. 能防止无限递归拉起子任务。
4. 能在子任务完成后记录结果摘要。

---

## 11. Completion Event 设计

### 11.1 原则

子任务结果必须推回父 session，而不是依赖父 agent 轮询。

### 11.2 建议事件格式

```ts
interface AgentInternalEvent {
  type: "task_completion";
  sourceProfileId: string;
  childSessionKey: string;
  taskId: string;
  status: "completed" | "failed" | "timeout" | "cancelled";
  taskLabel: string;
  result: string;
  stats?: {
    runtimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

### 11.3 行为

- 子任务完成后，把 `task_completion` 注入父 session。
- 父 session 收到后继续执行下一步，而不是让用户再次触发。
- 如果父 session 本身也是子任务，则事件继续向上游传播，直到到达 commander 或根会话。

---

## 12. 记忆策略

### 12.1 为什么不能只沿用现有 `main/direct/group`

当前记忆隔离适合用户维度和会话维度，但多 agent 后还要考虑“角色维度”。

例如：

- 告警专家应能访问 incident 历史。
- 成本专家应能访问 FinOps 规则与资源账单摘要。
- commander 应能汇总共享团队知识，但不一定写入所有专家私有工作记忆。

### 12.2 建议策略

记忆分 3 层：

1. Shared Team Memory
- 团队共享规则、约束、历史共识。

2. Expert Working Memory
- 专家私有的工作中间态、偏好、局部经验。

3. Work Item Memory
- 与 incident/change/cost-case 绑定的任务记忆。

### 12.3 推荐模式

- commander：`hybrid`
  - 读共享团队记忆
  - 只在必要时写共享结论

- specialist：默认 `hybrid`
  - 读共享
  - 写专家隔离 scope 或 work-item scope

### 12.4 与现有 scope 的兼容

现有 `main / direct / group` 不废弃，而是作为“外层会话隔离”。

在其之上叠加专家维度，例如：

```text
team/main
team/group_web_ops-room
expert/alert-triage
expert/cost-optimizer
work/incident/INC-2026-0001
```

---

## 13. 工具权限策略

### 13.1 原则

多 agent 的价值之一就是工具边界明确。

### 13.2 推荐分层

1. 平台通用工具
- `memory_search`
- `memory_get`
- `memory_save`
- `heartbeat_save`

2. 受限执行工具
- `exec_command`
- 云平台相关 MCP
- 集群/CI/CD/安全扫描 MCP

3. 协作工具
- `experts_list`
- `sessions_spawn`
- `sessions_send`
- `tasks_list`
- `tasks_cancel`

### 13.3 建议限制

- commander 默认不直接拥有全部高风险执行权限。
- specialist 按职责获得最小必要工具。
- `exec_command` 继续受现有白名单、黑名单、审批、审计约束。

---

## 14. 与 DeepAgents subagent 的关系

### 14.1 结论

DeepAgents `subagent` 仍然有价值，但只适合作为“专家内部 helper”，不适合作为团队级多 agent 主架构。

### 14.2 适合的场景

- 帮专家整理输出格式
- 生成简版 RCA
- 把一个大文件切分总结
- 生成或维护技能文件

### 14.3 不适合的场景

- 独立专家角色
- 专家级权限隔离
- 跨 session 协作
- 并行任务编排
- 可追踪的任务树与生命周期管理

### 14.4 推荐定位

- 外层：智能体 风格的 session 协作架构
- 内层：DeepAgents subagent 作为单专家内部的微代理能力

这是一个混合方案，而不是二选一。

---

## 15. SRE Pack 只是示例，不是硬编码

### 15.1 原则

SRE 专家包是当前项目最合适的第一套 pack，但不能写成框架内建唯一角色。

### 15.2 首套示例专家

- `sre-commander`
- `alert-triage`
- `cost-optimizer`
- `vuln-remediator`
- `delivery-operator`

### 15.3 意义

- 它们是配置实例。
- 不是运行时硬编码常量。
- 后续可再增加：
  - `engineering-team`
  - `product-team`
  - `ops-support-team`

---

## 16. 分阶段落地建议

### 第一阶段：引入通用配置与注册表

目标：
- 不改现有渠道接入模式
- 不引入多账号
- 不拆现有主 agent 对外入口

工作项：
- 新增 `AgentProfile` / `AgentPack` schema
- 新增 `AgentRegistry`
- 把当前主 agent 从 `SREBot` 固定身份改成可由 `commander profile` 驱动

### 第二阶段：引入协作层

工作项：
- 新增 `experts_list`
- 新增 `sessions_spawn`
- 新增 `sessions_send`
- 新增 `TaskRegistry`
- 新增 `task_completion` 内部事件

### 第三阶段：引入专家级工具/记忆策略

工作项：
- 工具按 profile 过滤注入
- 专家记忆 scope 与 work-item scope
- 限制子任务深度和活跃并发数

### 第四阶段：补齐运维与可观测性

工作项：
- 子任务状态查询
- 子任务取消
- 专家协作日志
- 失败重试与超时策略

---

## 17. 对当前代码的直接影响

建议重点改造这些区域：

1. `src/agent.ts`
- 从固定 `createSREAgent` 走向“按 profile 构建 agent runtime”。

2. `src/conversation/runtime.ts`
- 从“一个 runtime 对应一个主 agent”走向“一个运行时可管理多个 profile session”。

3. `src/subagents/`
- 保留，但定位调整为专家内部 helper。

4. `src/middleware/`
- 在现有会话隔离上增加专家/任务维度记忆策略。

5. `src/channels/gateway/`
- 入口仍保持统一，但进入业务前增加 commander/profile resolution。

---

## 18. 风险与取舍

### 18.1 主要风险

1. 架构过度设计
- 如果一开始复制 智能体 全套控制面，会显著抬高项目复杂度。

2. prompt 与运行时边界不清
- 如果 profile 只是换个 prompt 名字，没有真正的工具/记忆/session 边界，多 agent 会退化成“角色扮演”。

3. 共享记忆污染
- 如果所有专家都写同一份主记忆，后期很容易混乱。

### 18.2 取舍

本项目应优先学习 智能体 的 3 个核心思想：

1. 专家是独立 profile，不是 prompt 片段。
2. 协作基于可寻址 session，而不是隐式上下文。
3. 子任务完成应 push 回父会话，而不是靠轮询。

不必在第一阶段复制：

1. 多渠道多账号绑定
2. 完整 A2A 多轮 ping-pong
3. 过重的 control plane

---

## 19. 最终建议

对于 srebot，多 agent 的正确方向不是：

- 把 4 个 SRE 角色硬编码进主 agent
- 或者完全依赖 DeepAgents subagent 模拟专家

而是：

- 先做一个通用多 agent / 多 session 协作框架
- 再把 SRE 作为第一套专家 pack
- 把 DeepAgents subagent 保留为专家内部微代理

一句话总结：

> srebot 应该从“单 SRE agent”演进为“团队助手框架”，SRE 只是第一套可插拔专家包。

