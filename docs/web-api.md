# Web 渠道对外 API

## 1. 目标

把 `web` 渠道从“内置调试页面”升级成可供外部前端接入的正式 API。

当前设计采用：

- WebSocket：承载实时对话和流式回复
- HTTP：承载健康检查、会话创建、附件下载、内置调试 UI

## 2. 设计结论

### 2.1 用户标识

外部调用方应传：

- `user_id`：业务侧稳定唯一用户 ID
- `nick_name`：展示名称，可变

约束：

- `user_id` 用于会话归属和多用户隔离
- `nick_name` 仅用于展示，不参与隔离

### 2.2 会话 ID 策略

结论：**默认由服务端生成，客户端按需保存与回传。**

原因：

- 避免多个前端各自实现一套 session 生成规则
- 避免低熵 session_id 导致串会话
- 便于后续在服务端增加权限、TTL、审计或迁移策略

因此推荐模式是：

1. 客户端建立 WebSocket 连接
2. 发送 `hello`，只传 `user_id` / `nick_name`
3. 服务端在 `hello_ack` 中返回 `session_id`
4. 客户端保存 `session_id`
5. 后续续聊时再把该 `session_id` 带回来

补充：

- 如果业务方已经有自己的会话恢复模型，也可以在 `hello` / `message` 中主动传 `session_id`
- 服务端允许复用已存在的 `session_id`
- 但同一个 `session_id` **禁止跨不同 `user_id` 复用**

### 2.3 多用户支持

当前已支持多用户并发聊天。

隔离模型：

- 每个 `session_id` 绑定一个 `user_id`
- 同一 `session_id` 内消息串行处理，避免上下文并发污染
- 不同 `session_id` 之间并发处理

这意味着：

- 多个用户可以同时聊天
- 一个用户可以持有多个会话
- 同一个用户可在多个前端/标签页恢复同一个 `session_id`
- 不同用户不能共享同一个 `session_id`

补充：

- `session_events` 会按 `session_id` 记录会话热日志，便于“上次/昨天/刚才”类回溯
- `memory_save` / `daily` / `long-term` 默认落到共享 `main`，适合团队共用记忆；如需按用户隔离，可把 `web_direct_scope` 改成 `direct`

## 3. HTTP API

### 3.1 健康检查

`GET /healthz`

响应：

```text
ok
```

### 3.2 创建或申请会话

`POST /api/web/sessions`

请求头：

```http
Content-Type: application/json
```

请求体：

```json
{
  "user_id": "u_1001",
  "nick_name": "Hunter",
  "session_id": "optional_existing_session_id",
  "session_title": "optional title"
}
```

字段说明：

- `user_id`：必填
- `nick_name`：可选
- `session_id`：可选；不传则服务端生成
- `session_title`：可选；仅展示用途

成功响应：

```json
{
  "ok": true,
  "session_id": "wsn_5c9d7f1e9d4b4f73a49a5f1e4305a4ae",
  "user_id": "u_1001",
  "nick_name": "Hunter",
  "session_title": "optional title",
  "created_at": 1772580000000,
  "reused": false
}
```

失败响应示例：

```json
{
  "ok": false,
  "error": {
    "code": "session_conflict",
    "message": "session_id=xxx 已绑定到其他 user_id，禁止跨用户复用。"
  }
}
```

说明：

- 该接口支持 `CORS`
- 如果你不想单独走 HTTP，也可以直接在 WebSocket `hello` 时让服务端生成 `session_id`

### 3.3 记忆持久化行为

Web 渠道当前默认会做三层持久化：

- 每条 `user/assistant` 消息写入 `workspace/memory/scopes/<scope>/transcripts/YYYY-MM-DD.md`
- 每条 `user/assistant` 消息尽量写入 PG `session_events`
- 当单会话 token 接近阈值时，后台触发 memory flush，把“进行中工作态摘要”写入 `daily` 记忆，并轮换 agent thread

这意味着：

- 原始会话可通过 transcript / `session_events` 回溯
- 关键信息会通过 `memory_save` 进入长期检索链路
- 多用户 Web API 现在默认共享 `main` scope，适合团队共享记忆

### 3.4 附件下载

服务端会在回复事件里返回附件列表：

```json
{
  "attachments": [
    {
      "id": "4ecf...",
      "name": "report.md",
      "url": "/web/attachments/4ecf.../report.md",
      "sizeBytes": 1024,
      "mimeType": "text/markdown; charset=utf-8"
    }
  ]
}
```

特点：

- 只允许下载 `workspace/tmp` 下被显式登记的文件
- 下载 URL 由服务端签发
- 文件注册有 TTL，不保证永久有效

## 4. WebSocket API

### 4.1 连接地址

默认：

```text
ws://<host>:18081/ws/web
```

### 4.2 建连流程

1. 客户端连接 WebSocket
2. 服务端返回 `hello_required`
3. 客户端发送 `hello`
4. 服务端返回正式 `hello_ack`
5. 客户端发送 `message`
6. 服务端返回 `dispatch_ack`
7. 服务端流式返回 `reply_start / reply_delta / reply_final`

### 4.3 客户端 -> 服务端事件

#### `hello`

```json
{
  "type": "hello",
  "client_id": "your-frontend",
  "user_id": "u_1001",
  "nick_name": "Hunter",
  "session_id": "optional_existing_session_id",
  "session_title": "optional title",
  "isDirect": true
}
```

规则：

- `user_id`：建议必填
- `nick_name`：建议必填
- `session_id`：可选；不传则服务端生成
- `client_id`：建议传前端标识，便于排障

#### `message`

```json
{
  "type": "message",
  "message_id": "msg_001",
  "request_id": "msg_001",
  "idempotency_key": "msg_001",
  "user_id": "u_1001",
  "nick_name": "Hunter",
  "session_id": "wsn_5c9d7f1e9d4b4f73a49a5f1e4305a4ae",
  "session_title": "工单排障",
  "text": "帮我总结今天的异常处理",
  "metadata": {
    "page": "support-console"
  }
}
```

建议：

- `message_id` 和 `request_id` 传同一个值即可
- `idempotency_key` 建议与 `message_id` 一致
- 如果连接已通过 `hello` 绑定过 `session_id`，`message.session_id` 可省略

#### `ping`

```json
{
  "type": "ping",
  "timestamp": 1772580000000
}
```

### 4.4 服务端 -> 客户端事件

#### `hello_required`

```json
{
  "type": "hello_required",
  "connection_id": "conn_xxx",
  "authenticated": true,
  "serverTime": 1772580000000
}
```

说明：

- 连接建立后，客户端仍然必须发送 `hello`
- `authenticated=true` 仅表示连接层无需 token，不代表会话已绑定

#### `hello_ack`

```json
{
  "type": "hello_ack",
  "connection_id": "conn_xxx",
  "client_id": "your-frontend",
  "user_id": "u_1001",
  "nick_name": "Hunter",
  "session_id": "wsn_5c9d7f1e9d4b4f73a49a5f1e4305a4ae",
  "session_title": "工单排障",
  "api_path": "/api/web/sessions",
  "authenticated": true,
  "serverTime": 1772580000000
}
```

关键点：

- `session_id` 一定要缓存下来
- 后续续聊时传回这个值

#### `dispatch_ack`

```json
{
  "type": "dispatch_ack",
  "message_id": "msg_001",
  "request_id": "msg_001",
  "session_id": "wsn_5c9d7f1e9d4b4f73a49a5f1e4305a4ae",
  "status": "processed",
  "timestamp": 1772580000100
}
```

状态：

- `processed`
- `duplicate`
- `skipped`
- `error`

#### `reply_start`

```json
{
  "type": "reply_start",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "timestamp": 1772580000200
}
```

#### `reply_delta`

```json
{
  "type": "reply_delta",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "delta": "今天处理了 3 个告警",
  "timestamp": 1772580000300
}
```

#### `reply_final`

```json
{
  "type": "reply_final",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "text": "今天处理了 3 个告警，剩余 1 个待跟进。",
  "attachments": [],
  "finishReason": "completed",
  "timestamp": 1772580000800
}
```

说明：

- `reply_delta` 用于实时打印
- `reply_final` 用于最终收敛和附件列表
- 建议以前端本地累积 `reply_delta`，最后用 `reply_final.text` 覆盖校正

#### `tool_start` / `tool_end`

```json
{
  "type": "tool_start",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "toolName": "memory_search",
  "timestamp": 1772580000400
}
```

```json
{
  "type": "tool_end",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "toolName": "memory_search",
  "timestamp": 1772580000500
}
```

#### `reply_error`

```json
{
  "type": "reply_error",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "message": "处理失败",
  "timestamp": 1772580000600
}
```

#### `error`

连接层或协议层错误，例如：

```json
{
  "type": "error",
  "code": "session_conflict",
  "message": "session_id=xxx 已绑定到其他 user_id，禁止跨用户复用。"
}
```

## 5. 字段兼容性

为了兼容旧版内置页面，当前服务端仍兼容一部分 camelCase 字段：

- `userId`
- `clientId`
- `sessionId`
- `messageId`
- `idempotencyKey`

但对外接入建议统一使用 snake_case：

- `user_id`
- `nick_name`
- `session_id`
- `message_id`
- `request_id`
- `idempotency_key`

## 6. 推荐接入策略

### 方案 A：最简接入

适合浏览器前端直接接入。

1. 建立 WebSocket
2. 发送 `hello`，不传 `session_id`
3. 收到 `hello_ack.session_id`
4. 后续消息都带这个 `session_id`

### 方案 B：前置申请会话

适合你要先生成一个稳定会话链接，再进入聊天页。

1. `POST /api/web/sessions`
2. 获取 `session_id`
3. 聊天页面建立 WebSocket
4. `hello` 时带上该 `session_id`

## 7. 当前限制

- 当前会话模型是“单用户私有会话”，不是群聊共享会话
- 跨用户复用同一个 `session_id` 会被拒绝
- 附件回传只支持 `workspace/tmp` 下被显式登记的文件
- 当前没有独立用户鉴权体系，`user_id` 的真实性依赖上游调用方保证

## 8. 对你当前项目的建议

你后续的另一个前端页面，建议按下面接：

1. 登录后拿业务侧稳定 `user_id`
2. 展示用名称走 `nick_name`
3. 新开聊天时不自己生成 `session_id`，让服务端分配
4. 把 `session_id` 存在前端路由参数、local storage 或后端会话表中
5. 恢复历史聊天时，复用这个 `session_id`

这样最稳，也最方便你以后扩容到移动端、小程序或服务端转发层。
