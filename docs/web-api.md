# Web 渠道对外 API

## 1. 目标

把 `web` 渠道从“内置调试页面”升级成可供外部前端接入的正式 API。

当前设计采用：

- WebSocket：承载实时对话和流式回复
- HTTP：承载健康检查、会话创建、上传接口、附件下载、内置调试 UI

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

### 3.3 上传图片和文件

`POST /api/web/uploads`

支持两种调用方式：

- `multipart/form-data`
- `application/json` + base64

推荐 `multipart/form-data`。

请求字段：

- `files` / `file`：一个或多个文件
- `user_id`：可选，建议传
- `session_id`：可选；如果传了，后续该附件只能被同一个 `session_id` 使用

`multipart/form-data` 示例：

```bash
curl -X POST "http://127.0.0.1:18081/api/web/uploads" \
  -F "user_id=u_1001" \
  -F "session_id=wsn_xxx" \
  -F "files=@./diagram.png" \
  -F "files=@./runbook.md"
```

JSON 示例：

```json
{
  "user_id": "u_1001",
  "session_id": "wsn_xxx",
  "files": [
    {
      "name": "runbook.md",
      "mime_type": "text/markdown; charset=utf-8",
      "content_base64": "IyBSdW5ib29rCi4uLg=="
    }
  ]
}
```

成功响应：

```json
{
  "ok": true,
  "uploads": [
    {
      "upload_id": "upl_123",
      "uploadId": "upl_123",
      "name": "diagram.png",
      "sizeBytes": 120394,
      "mimeType": "image/png",
      "mime_type": "image/png",
      "mediaType": "image",
      "media_type": "image"
    }
  ]
}
```

说明：

- 单次最多 `5` 个文件
- 单文件默认限制 `20MB`
- 上传成功后，需要在 WebSocket `message.attachments[].upload_id` 中引用
- 内置 Web UI 发送附件时，走的也是这套接口

### 3.4 记忆持久化行为

Web 渠道当前默认会做三层持久化：

- 每条 `user/assistant` 消息写入 `workspace/memory/scopes/<scope>/transcripts/YYYY-MM-DD.md`
- 每条 `user/assistant` 消息尽量写入 PG `session_events`
- 当单会话 token 接近阈值时，后台触发 memory flush，把“进行中工作态摘要”写入 `daily` 记忆，并轮换 agent thread

这意味着：

- 原始会话可通过 transcript / `session_events` 回溯
- 关键信息会通过 `memory_save` 进入长期检索链路
- 多用户 Web API 现在默认共享 `main` scope，适合团队共享记忆

### 3.5 附件下载

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
7. 服务端返回 `reply_start`
8. 如存在过程信息，服务端继续返回 `process_start / process_delta / process_step`
9. 服务端最终返回 `reply_final`

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
  "attachments": [
    {
      "upload_id": "upl_123"
    }
  ],
  "metadata": {
    "page": "support-console"
  }
}
```

建议：

- `message_id` 和 `request_id` 传同一个值即可
- `idempotency_key` 建议与 `message_id` 一致
- 如果连接已通过 `hello` 绑定过 `session_id`，`message.session_id` 可省略
- 如果只发图片/文件，`text` 可以为空，但 `attachments` 不能为空
- `attachments` 当前只接受上传接口返回的 `upload_id`

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
  "upload_api_path": "/api/web/uploads",
  "authenticated": true,
  "serverTime": 1772580000000
}
```

关键点：

- `session_id` 一定要缓存下来
- 后续续聊时传回这个值
- `upload_api_path` 可直接给外部前端做上传入口

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

#### `process_start`

```json
{
  "type": "process_start",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "sourceMessageId": "msg_001",
  "title": "执行过程",
  "default_collapsed": true,
  "timestamp": 1772580000250
}
```

用途：

- 前端应把它渲染成一个默认折叠的“小过程窗口”
- 标题建议直接使用 `title`

#### `process_delta`

```json
{
  "type": "process_delta",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "sourceMessageId": "msg_001",
  "block_type": "commentary",
  "delta": "首先让我读取 skill 的完整说明。",
  "timestamp": 1772580000300
}
```

用途：

- 表示“执行过程文本”的增量更新
- 推荐追加到折叠过程窗口中，而不是主回答正文

#### `process_step`

```json
{
  "type": "process_step",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "sourceMessageId": "msg_001",
  "step_type": "tool_start",
  "tool_name": "read_skill",
  "preview": "读取 SKILL.md",
  "timestamp": 1772580000400
}
```

字段说明：

- `step_type`：当前为 `tool_start` / `tool_end`
- `tool_name`：工具名
- `preview`：可选，服务端提取的短摘要

用途：

- 前端可把它渲染成“步骤列表”或“时间线”
- 推荐展示在折叠过程窗口中

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

说明：

- `reply_delta` 现在是“正文增量”的兼容事件
- 当服务端需要先归集执行过程时，`reply_delta` 可能为空缺或明显减少
- 新前端不要依赖 `reply_delta` 作为唯一渲染来源；应以 `reply_final.text` 为最终正文

#### `reply_final`

```json
{
  "type": "reply_final",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "text": "今天处理了 3 个告警，剩余 1 个待跟进。",
  "process": {
    "title": "执行过程",
    "default_collapsed": true,
    "summary": "已记录 2 段过程文本，涉及 2 个工具：read_skill, exec_command",
    "text": "首先让我读取 skill。\n\n开始调用工具 read_skill\n\n工具执行完成 read_skill：已获取 skill 工作流",
    "blocks": [
      {
        "type": "commentary",
        "text": "首先让我读取 skill。"
      },
      {
        "type": "tool",
        "phase": "start",
        "toolName": "read_skill",
        "preview": "读取 SKILL.md"
      }
    ]
  },
  "attachments": [],
  "finishReason": "completed",
  "timestamp": 1772580000800
}
```

说明：

- `reply_delta` 用于实时打印
- `reply_final` 用于最终收敛和附件列表
- `reply_final.text` 是最终正文，必须优先使用
- `reply_final.process` 是完整的过程快照，前端应用它来校正本地累积的 `process_*` 状态
- 建议以前端本地累积 `process_delta / process_step`，最后用 `reply_final.process` 覆盖校正

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

说明：

- 这两个事件为兼容保留
- 新前端应优先使用 `process_step`
- 如果你的前端已经接了 `tool_start` / `tool_end`，可以继续使用，但建议逐步迁移到 `process_step`

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

### 过程窗口渲染建议

推荐前端渲染方式：

1. 主消息正文只展示 `reply_final.text`
2. 折叠过程窗口展示 `process_start / process_delta / process_step`
3. 收到 `reply_final.process` 后，用它覆盖本地过程状态，避免增量丢失或重复

这样可以避免把“执行过程文本”直接混到主回答里。

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
- 入站附件需要先上传，再通过 `upload_id` 引用
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
