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
  "reused": false,
  "token_usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "contextTokens": 0,
    "contextWindow": 128000,
    "contextUsagePercent": 0,
    "contextRemainingTokens": 128000,
    "contextRemainingPercent": 100,
    "hardContextBudget": 108000,
    "hardContextRemainingTokens": 108000,
    "autoCompactThreshold": 80000,
    "autoCompactRemainingTokens": 80000,
    "flushCount": 0,
    "flushCycleArmed": true,
    "updatedAt": 1772580000000,
    "formatted": {
      "inputTokens": "0",
      "outputTokens": "0",
      "contextTokens": "0",
      "contextWindow": "128.0K",
      "contextRemainingTokens": "128.0K",
      "hardContextBudget": "108.0K",
      "autoCompactThreshold": "80.0K"
    }
  },
  "tokenUsage": {
    "...": "与 token_usage 相同，兼容 camelCase 读取"
  }
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
- `token_usage` / `tokenUsage` 会返回该会话当前累计 token 占用，适合前端在建会话后立即渲染右下角占用信息

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

同时，Web 侧和 DingTalk 侧已对齐两项记忆策略：
- 会话首轮会注入 scope 下“今天 + 昨天”的 daily 摘要（`memory/scopes/<scope>/YYYY-MM-DD.md`）
- 命中回溯意图（如“之前/上次/昨天/聊过/记得吗”）时，会先注入 `memory_search` 强约束提示，再回答

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

### 3.6 管理 SKILL 与记忆 Markdown

用于前端管理技能目录内文件（含 `SKILL.md`、其他 `.md`、脚本等）以及 `MEMORY.md / memory/*.md`。

接口：

- `GET /api/web/files/skills`
- `GET /api/web/files/skills?skill=<目录名>[&path=<技能内相对路径>]`
- `PUT /api/web/files/skills`
- `GET /api/web/files/memory?path=<相对路径>`
- `PUT /api/web/files/memory`

鉴权：

- 若配置了 `web.authToken`，请求需带 `Authorization: Bearer <token>`，或 `x-web-auth-token: <token>`。
- 若未配置 `web.authToken`，默认放行（建议内网使用）。

`GET /api/web/files/skills` 响应示例：

```json
{
  "ok": true,
  "skills": [
    {
      "skill": "alert-rca",
      "path": "/abs/path/workspace/skills/alert-rca/SKILL.md",
      "sizeBytes": 1024,
      "updatedAtMs": 1772580000000
    }
  ]
}
```

`GET /api/web/files/skills?skill=alert-rca` 响应示例：

```json
{
  "ok": true,
  "skill": "alert-rca",
  "skillRootPath": "/abs/path/workspace/skills/alert-rca",
  "summary": {
    "fileCount": 6,
    "directoryCount": 2
  },
  "tree": [
    {
      "path": "docs",
      "name": "docs",
      "kind": "directory",
      "children": [
        { "path": "docs/README.md", "name": "README.md", "kind": "file", "sizeBytes": 512, "updatedAtMs": 1772580000000 }
      ]
    },
    { "path": "scripts/fix.py", "name": "fix.py", "kind": "file", "sizeBytes": 120, "updatedAtMs": 1772580000000 },
    { "path": "SKILL.md", "name": "SKILL.md", "kind": "file", "sizeBytes": 1024, "updatedAtMs": 1772580000000 }
  ],
  "file": {
    "relativePath": "SKILL.md",
    "absPath": "/abs/path/workspace/skills/alert-rca/SKILL.md",
    "missing": false,
    "sizeBytes": 1024,
    "updatedAtMs": 1772580000000,
    "content": "---\nname: alert-rca\n..."
  }
}
```

`PUT /api/web/files/skills` 请求示例：

```json
{
  "skill": "alert-rca",
  "path": "docs/README.md",
  "content": "---\nname: alert-rca\n..."
}
```

说明：

- `path` 可选，默认 `SKILL.md`
- `path` 必须是技能目录内相对路径（禁止 `..` 和绝对路径）
- `GET` 返回技能目录树（`tree`，节点含 `children`）以及当前读取文件内容（`file`）

`GET /api/web/files/memory` 默认读取 `MEMORY.md`。你也可以传 `path=memory/2026-03-11.md` 等路径。

限制：

- `skills` 仅允许访问 `workspace/skills/<skill>/` 目录内的普通文件（拒绝越界路径、符号链接、硬链接）
- 只允许访问 `MEMORY.md` 或 `memory/**/*.md`
- 禁止 `..`、绝对路径、符号链接/硬链接目标

### 3.7 管理 MCP 运行态

用于查询当前进程里已加载的 MCP server / tools，并对 MCP 做热重载、启停、增删改。

接口：

- `GET /api/web/mcp`
- `POST /api/web/mcp`

鉴权：

- 若配置了 `web.authToken`，请求需带 `Authorization: Bearer <token>`，或 `x-web-auth-token: <token>`。
- 若未配置 `web.authToken`，默认放行（建议内网使用）。

`GET /api/web/mcp` 响应示例：

```json
{
  "ok": true,
  "mcp": {
    "enabled": true,
    "serverCount": 2,
    "loadedServerCount": 1,
    "toolCount": 3,
    "servers": [
      {
        "name": "filesystem",
        "transport": "stdio",
        "config": {
          "enabled": true,
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"]
        },
        "enabled": true,
        "loaded": true,
        "toolCount": 3,
        "tools": [
          {
            "name": "filesystem_read_file",
            "rawName": "read_file",
            "description": "Read a file from the configured root.",
            "serverName": "filesystem",
            "inputSchema": {
              "type": "object",
              "required": ["path"],
              "properties": {
                "path": { "type": "string", "description": "Absolute path" }
              }
            },
            "parameters": [
              {
                "name": "path",
                "type": "string",
                "description": "Absolute path",
                "required": true
              }
            ]
          }
        ]
      },
      {
        "name": "weather",
        "transport": "sse",
        "enabled": false,
        "loaded": false,
        "toolCount": 0,
        "tools": []
      }
    ],
    "tools": [
      {
        "name": "filesystem_read_file",
        "rawName": "read_file",
        "description": "Read a file from the configured root.",
        "serverName": "filesystem",
        "inputSchema": {
          "type": "object",
          "required": ["path"],
          "properties": {
            "path": { "type": "string", "description": "Absolute path" }
          }
        },
        "parameters": [
          {
            "name": "path",
            "type": "string",
            "description": "Absolute path",
            "required": true
          }
        ]
      }
    ]
  }
}
```

`POST /api/web/mcp` 请求示例：

```json
{ "action": "reload" }
```

```json
{ "action": "set-global-enabled", "enabled": false }
```

```json
{ "action": "set-server-enabled", "serverName": "filesystem", "enabled": false }
```

```json
{
  "action": "upsert-server",
  "serverName": "browser",
  "server": {
    "enabled": true,
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@demo/browser-mcp"]
  }
}
```

```json
{ "action": "remove-server", "serverName": "browser" }
```

说明：

- 所有变更都会触发 agent 热重载，成功后响应里返回最新 MCP 运行态
- 变更会同步写回项目根目录 `config.json` 的 `mcp` 配置段，服务重启后仍然生效
- 若热重载失败，会自动回滚到变更前的 MCP 配置
- `tools` 返回的是当前 agent 实际已挂载的 MCP 工具，而不是仅回显静态配置
- `servers[].config` 返回当前 server 的完整配置，适合前端编辑弹窗做表单回填
- `tools[].inputSchema` / `tools[].parameters` 可用于展示 MCP 工具参数说明

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

### 4.2.1 Token 占用字段

Web 渠道现在会在多个响应和事件中附带统一的 token 占用快照：

- `token_usage`
- `tokenUsage`

两者内容相同，只是分别兼容 snake_case 和 camelCase 读取。

字段定义：

```json
{
  "inputTokens": 4200,
  "outputTokens": 1800,
  "contextTokens": 115000,
  "contextWindow": 128000,
  "contextUsagePercent": 90,
  "contextRemainingTokens": 13000,
  "contextRemainingPercent": 10,
  "hardContextBudget": 108000,
  "hardContextRemainingTokens": 0,
  "autoCompactThreshold": 80000,
  "autoCompactRemainingTokens": 0,
  "flushCount": 1,
  "flushCycleArmed": false,
  "updatedAt": 1772580000800,
  "formatted": {
    "inputTokens": "4.2K",
    "outputTokens": "1.8K",
    "contextTokens": "115.0K",
    "contextWindow": "128.0K",
    "contextRemainingTokens": "13.0K",
    "hardContextBudget": "108.0K",
    "autoCompactThreshold": "80.0K"
  }
}
```

字段说明：

- `inputTokens`：当前会话累计输入 token
- `outputTokens`：当前会话累计输出 token
- `contextTokens`：当前会话上下文累计 token，占用展示建议优先使用这个字段
- `contextWindow`：配置的上下文窗口上限
- `contextUsagePercent`：`contextTokens / contextWindow` 的百分比
- `contextRemainingTokens`：距离 `contextWindow` 还剩多少 token
- `hardContextBudget`：扣除 `reserve_tokens` 后的硬预算
- `autoCompactThreshold`：自动压缩阈值
- `flushCount`：当前会话已触发的 memory flush 次数
- `flushCycleArmed`：当前是否允许再次触发 flush
- `updatedAt`：服务端生成该快照的时间戳
- `formatted.*`：服务端已格式化好的显示文案，前端可直接展示，也可自行格式化

推荐前端展示逻辑：

- 右下角主要显示 `contextUsagePercent`
- hover/展开时显示 `contextTokens / contextWindow`
- 如需展示“自动压缩阈值”，用 `autoCompactThreshold`
- 如需展示“硬预算”，用 `hardContextBudget`

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

#### `cancel`

用于中断当前会话中正在执行的一轮请求。

```json
{
  "type": "cancel",
  "session_id": "wsn_5c9d7f1e9d4b4f73a49a5f1e4305a4ae",
  "request_id": "msg_001"
}
```

字段说明：

- `session_id`：建议必填，用于定位要中断的会话
- `request_id`：可选；传了则只允许中断指定请求，不传则默认中断该会话当前正在执行的请求

推荐前端行为：

- 点击“中断”按钮时，发送 `type=cancel`
- 如果当前界面明确知道正在执行的是哪条消息，建议同时传 `request_id`
- 发送后先把按钮切成 loading/disabled，等待 `cancel_ack`
- 收到 `cancel_ack.status=accepted` 后，继续等待服务端返回最终的 `reply_cancelled`

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
  "serverTime": 1772580000000,
  "token_usage": {
    "contextTokens": 0,
    "contextWindow": 128000,
    "contextUsagePercent": 0
  }
}
```

关键点：

- `session_id` 一定要缓存下来
- 后续续聊时传回这个值
- `upload_api_path` 可直接给外部前端做上传入口
- `hello_ack.token_usage` 可用于页面首次建立连接或刷新重连后的占用恢复

#### `dispatch_ack`

```json
{
  "type": "dispatch_ack",
  "message_id": "msg_001",
  "request_id": "msg_001",
  "session_id": "wsn_5c9d7f1e9d4b4f73a49a5f1e4305a4ae",
  "status": "processed",
  "timestamp": 1772580000100,
  "token_usage": {
    "contextTokens": 2300,
    "contextWindow": 128000,
    "contextUsagePercent": 2
  }
}
```

状态：

- `processed`
- `duplicate`
- `skipped`
- `error`

#### `cancel_ack`

```json
{
  "type": "cancel_ack",
  "session_id": "wsn_xxx",
  "request_id": "msg_001",
  "status": "accepted",
  "timestamp": 1772580000150
}
```

状态：

- `accepted`：中断请求已被服务端受理
- `already_cancelled`：该请求之前已经发起过中断
- `not_found`：当前会话没有活跃请求，或 `request_id` 与当前活跃请求不匹配
- `unsupported`：当前服务端未开启中断能力
- `error`：服务端处理取消请求时发生异常

说明：

- `cancel_ack` 只表示“服务端已收到并登记中断请求”，不代表最终回复已经停止
- 前端收到 `accepted` 后，仍应继续等待 `reply_cancelled` 或 `reply_final`
- 如果收到 `not_found`，通常表示当前这轮已经结束，或者前端传错了 `request_id`
- 如果当前活跃请求正在执行 `exec` 工具，服务端会尝试终止对应的子进程

#### `reply_start`

```json
{
  "type": "reply_start",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "timestamp": 1772580000200,
  "token_usage": {
    "inputTokens": 4200,
    "contextTokens": 4200,
    "contextWindow": 128000,
    "contextUsagePercent": 3
  }
}
```

说明：

- `reply_start.token_usage` 一般反映“本轮用户输入入账后”的会话占用
- 如果你希望右下角尽早刷新，建议在收到 `reply_start` 时就更新显示

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
  "timestamp": 1772580000800,
  "token_usage": {
    "inputTokens": 4200,
    "outputTokens": 1800,
    "contextTokens": 6000,
    "contextWindow": 128000,
    "contextUsagePercent": 5
  }
}
```

说明：

- `reply_delta` 用于实时打印
- `reply_final` 用于最终收敛和附件列表
- `reply_final.text` 是最终正文，必须优先使用
- `reply_final.process` 是完整的过程快照，前端应用它来校正本地累积的 `process_*` 状态
- 建议以前端本地累积 `process_delta / process_step`，最后用 `reply_final.process` 覆盖校正
- `reply_final.token_usage` 一般是“本轮 assistant 输出入账后”的最新会话占用，推荐作为右下角显示的主更新源

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

说明：

- `reply_error` 同样可能携带 `token_usage`
- 即使这一轮失败，前端也可以继续刷新当前会话的占用显示

#### `reply_cancelled`

```json
{
  "type": "reply_cancelled",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "text": "已经生成的部分内容",
  "reason": "cancelled_by_user",
  "timestamp": 1772580000650,
  "token_usage": {
    "inputTokens": 4200,
    "outputTokens": 0,
    "contextTokens": 4200,
    "contextWindow": 128000,
    "contextUsagePercent": 3
  }
}
```

说明：

- `reply_cancelled` 表示当前正在执行的一轮回复已被中断
- `text` 可能包含中断前已经生成的部分可见内容，也可能为空
- `reason` 当前固定为 `cancelled_by_user`
- 前端应把这一轮 UI 状态收敛成“已停止”，不要继续等待 `reply_final`
- 当前实现是“协作式流中断 + exec 子进程终止”：
  服务端会尽快停止向前端继续推送结果，并尝试终止当前活跃的 `exec` 子进程
  但对于不走 `exec` 的长耗时外部调用，仍不承诺一定能立刻停止

#### `session_state`

```json
{
  "type": "session_state",
  "request_id": "msg_001",
  "session_id": "wsn_xxx",
  "reason": "memory_flush",
  "timestamp": 1772580000900,
  "token_usage": {
    "contextTokens": 0,
    "contextWindow": 128000,
    "contextUsagePercent": 0,
    "flushCount": 1
  }
}
```

说明：

- 该事件用于主动同步会话状态变化
- 当前已用于 `memory_flush` 之后，把压缩后的最新 token 占用推给前端
- 如果你右下角需要像 Codex 一样在压缩后立刻跳变，应监听这个事件

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

### 中断按钮接入建议

如果你的前端后续要在右下角或消息气泡附近提供“停止生成”按钮，推荐顺序：

1. 在收到 `dispatch_ack` 后，记录当前活跃的 `session_id + request_id`
2. 在收到 `reply_start` 后，把按钮切到可点击状态
3. 用户点击按钮时，发送 `cancel`
4. 收到 `cancel_ack.status=accepted` 后，把按钮切到“中断中”
5. 收到 `reply_cancelled` 后，结束 loading，并把该轮消息标记为“已中断”

建议注意：

- 如果一轮请求已经收到 `reply_final` 或 `reply_error`，就不要再发送 `cancel`
- 如果用户连续点击多次，前端可以自行去重；服务端会返回 `already_cancelled`
- 如果你只维护单会话单活跃请求，也仍建议保留 `request_id`，这样更稳

### Token 占用显示建议

如果你要在聊天窗口右下角展示 token 占用，推荐顺序：

1. 页面初始化或重连时，读取 `hello_ack.token_usage`
2. 如果走 HTTP 建会话，优先读取 `/api/web/sessions` 返回里的 `token_usage`
3. 收到 `reply_start` 时，先用该事件里的 `token_usage` 更新
4. 收到 `reply_final` 时，再用 `reply_final.token_usage` 覆盖
5. 收到 `session_state(reason=memory_flush)` 时，再次刷新，确保压缩后的数字正确

最稳妥的前端策略是：

- 始终以“最后一个携带 `token_usage` 的事件”为准
- 右下角主展示用 `contextUsagePercent`
- 详情浮层展示 `contextTokens / contextWindow`

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
