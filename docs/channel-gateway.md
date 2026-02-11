# 渠道网关设计（Gateway + Adapter）

## 1. 目标

在不影响既有 DingTalk 能力的前提下，把“渠道接入”与“Agent 核心能力”解耦，形成可扩展的多渠道架构：

- 核心能力：Agent、Memory、Compaction、Cron、Exec 审批等
- 渠道能力：DingTalk / iOS / 飞书 / 安卓等协议适配

## 2. 当前实现

### 2.1 通用会话上下文

- 文件：`src/channels/context.ts`
- 能力：
  - `withChannelConversationContext`
  - `getChannelConversationContext`
  - `queueChannelReplyFile` / `consumeQueuedChannelReplyFiles`

该上下文是 channel 无关抽象，后续所有渠道复用。

### 2.2 网关抽象

- 文件：`src/channels/gateway/types.ts`
  - `ChannelAdapter`
  - `ChannelInboundMessage`
  - `ChannelOutboundMessage`
  - `ChannelCapabilities`
- 文件：`src/channels/gateway/service.ts`
  - `GatewayService.registerAdapter/unregisterAdapter`
  - `GatewayService.start/stop`
  - `GatewayService.dispatchInbound`（含幂等去重）
  - `GatewayService.sendProactive`

### 2.3 DingTalk Adapter

- 文件：`src/channels/dingtalk/adapter.ts`
- 状态：skeleton 已接入
  - `sendReply` -> `sendBySession`
  - `sendProactive` -> `sendProactiveMessage`
  - `handleInbound` -> 交给 `GatewayService`

### 2.4 DingTalk 主流程接入网关

- 文件：`src/dingtalk.ts`
- 变化：
  - `TOPIC_ROBOT` 回调改为 `dingtalkAdapter.handleInbound(...)`
  - 网关 `onProcessInbound` 里仍调用原 `handleMessage(...)`
  - `TOPIC_CARD` 审批回调维持原路径

这意味着行为不变，但接入面已标准化。

## 3. 启动模型

### 3.1 单渠道（DingTalk）

```bash
pnpm dingtalk
```

### 3.2 统一服务端（多渠道入口）

```bash
pnpm run server
```

可通过 `CHANNELS` 指定渠道集合：

```bash
CHANNELS=dingtalk pnpm run server
```

## 4. 日志

统一服务端模式下：

- `logs/server-YYYY-MM-DD.log`：网关/服务端日志
- `logs/dingtalk-server-YYYY-MM-DD.log`：DingTalk 通道日志

## 5. 新增渠道接入步骤（建议）

以“飞书”或“iOS WS”为例：

1. 新建 `src/channels/<channel>/adapter.ts` 并实现 `ChannelAdapter`
2. 解析渠道原始消息为 `ChannelInboundMessage`
3. 实现 `sendReply` / `sendProactive`
4. 在 `src/server.ts` 中注册并启动 adapter
5. 补充渠道配置项与 README 文档

## 6. 约束与建议

- 幂等键建议优先使用渠道原生 message id，避免重放造成重复执行
- 非 DingTalk 渠道建议自定义 session scope 前缀，避免记忆串线
- 渠道扩展优先“新增 adapter”，避免修改核心 `handler` 业务逻辑
