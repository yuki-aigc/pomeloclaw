# Hooks API

## 1. 目标

提供一个通用的异步 Hook 入口：

- 外部平台 `POST /hooks/agent`
- 服务端立即返回 `202 Accepted`
- Pomeloclaw 在后台执行 Agent 分析
- 分析完成后回调平台

当前设计不直接负责钉钉通知。通知编排、去重、聚合和升级策略建议由平台侧负责。

## 2. 启动方式

```bash
# 独立启动 hooks 服务
pnpm hooks

# 或通过统一服务端启动
CHANNELS=hooks pnpm run server
```

默认监听：

```text
http://0.0.0.0:18082/hooks/agent
```

健康检查：

```text
GET /healthz
```

## 3. 配置

```jsonc
{
  "hooks": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 18082,
    "path": "/hooks/agent",
    "authToken": "replace-me",
    "maxPayloadBytes": 262144,
    "maxConcurrentTasks": 2,
    "taskTtlMs": 86400000,
    "shutdownDrainTimeoutMs": 15000,
    "callback": {
      "timeoutMs": 10000,
      "retries": 2,
      "retryDelayMs": 1000
    }
  }
}
```

字段说明：

- `authToken`: 服务端接收 Hook 时的鉴权 token。支持 `Authorization: Bearer <token>`。
- `maxPayloadBytes`: 单次 Hook 请求体大小限制。
- `maxConcurrentTasks`: 全局最大并发 Hook task 数，避免挤占其他渠道。
- `taskTtlMs`: 内存中任务去重和状态保留时长。
- `shutdownDrainTimeoutMs`: 进程退出时等待后台 Hook task 收尾的最长时间。
- `callback.*`: 回调平台时的默认超时、重试次数和重试间隔。

## 4. 请求

### 4.1 路由

`POST /hooks/agent`

### 4.2 请求头

```http
Content-Type: application/json
Authorization: Bearer <hooks.authToken>
```

### 4.3 请求体

```json
{
  "request_id": "alert-20260403-001",
  "session_key": "alert:highcpu:host-a",
  "prompt": "请分析这条告警，输出简洁结论、可能原因和建议动作。",
  "payload": {
    "severity": "critical",
    "labels": {
      "alertname": "HighCPU",
      "instance": "host-a"
    },
    "annotations": {
      "summary": "CPU > 90% 持续 10 分钟"
    }
  },
  "metadata": {
    "source": "alertmanager",
    "tenant": "prod"
  },
  "callback": {
    "url": "https://platform.example.com/api/agent/callback",
    "token": "callback-secret",
    "headers": {
      "x-platform": "alert-center"
    },
    "timeoutMs": 5000,
    "retries": 1,
    "retryDelayMs": 500
  }
}
```

关键字段：

- `request_id`: 幂等键。重复请求会复用已有任务，不会重复执行。
- `session_key`: 会话键。相同 `session_key` 的任务按顺序串行执行，适合同一类告警滚动分析。
- `prompt`: 本次 Hook 的分析提示词。
- `payload`: 业务原始数据，会拼接到 Agent 输入中。
- `callback`: 任务完成后的回调配置。

## 5. 同步响应

服务端收到请求后立即返回：

```json
{
  "ok": true,
  "accepted": true,
  "duplicate": false,
  "task_id": "hook_123456",
  "request_id": "alert-20260403-001",
  "session_key": "alert:highcpu:host-a",
  "status": "accepted",
  "accepted_at": "2026-04-03T02:16:00.000Z"
}
```

HTTP 状态码：

- `202`: 已接收，后台执行中
- `400`: 请求体非法
- `401`: token 非法
- `404`: 路由不存在

## 6. 回调平台

任务结束后，Pomeloclaw 会向 `callback.url` 发起 `POST`。

平台侧可以按以下协议解析回调：

- `schema_version`: 当前固定为 `v1`
- `event`: 当前固定为 `hook.task.completed`
- `status`: `succeeded` 或 `failed`
- `task_id/request_id/session_key`: 用于关联平台侧原始请求
- `result`: 成功时的 Agent 输出
- `error`: 失败时的错误摘要

成功示例：

```json
{
  "schema_version": "v1",
  "event": "hook.task.completed",
  "task_id": "hook_123456",
  "request_id": "alert-20260403-001",
  "session_key": "alert:highcpu:host-a",
  "status": "succeeded",
  "accepted_at": "2026-04-03T02:16:00.000Z",
  "started_at": "2026-04-03T02:16:00.200Z",
  "finished_at": "2026-04-03T02:16:08.600Z",
  "result": {
    "text": "结论：host-a CPU 持续高位，优先排查异常流量或死循环任务。",
    "metadata": {
      "scopeKey": "direct_hook_alert_highcpu_host-a"
    }
  },
  "error": null,
  "metadata": {
    "source": "alertmanager",
    "tenant": "prod"
  }
}
```

失败示例：

```json
{
  "schema_version": "v1",
  "event": "hook.task.completed",
  "task_id": "hook_123456",
  "request_id": "alert-20260403-001",
  "session_key": "alert:highcpu:host-a",
  "status": "failed",
  "accepted_at": "2026-04-03T02:16:00.000Z",
  "started_at": "2026-04-03T02:16:00.200Z",
  "finished_at": "2026-04-03T02:16:04.100Z",
  "result": null,
  "error": {
    "message": "模型调用失败"
  },
  "metadata": {
    "source": "alertmanager",
    "tenant": "prod"
  }
}
```

回调请求头：

- `Content-Type: application/json`
- 若配置了 `callback.token`，则带 `Authorization: Bearer <token>`
- 若配置了 `callback.headers`，会一并透传

## 7. 任务查询接口

为便于排障，Hook 服务提供任务查询接口：

`GET /hooks/agent/tasks/:request_id`

请求头：

```http
Authorization: Bearer <hooks.authToken>
```

成功响应示例：

```json
{
  "ok": true,
  "task": {
    "task_id": "hook_123456",
    "request_id": "alert-20260403-001",
    "session_key": "alert:highcpu:host-a",
    "status": "succeeded",
    "accepted_at": "2026-04-03T02:16:00.000Z",
    "started_at": "2026-04-03T02:16:00.200Z",
    "finished_at": "2026-04-03T02:16:08.600Z",
    "prompt": "请分析这条告警，输出简洁结论、可能原因和建议动作。",
    "payload": {
      "severity": "critical"
    },
    "metadata": {
      "source": "alertmanager"
    },
    "result": {
      "text": "结论：host-a CPU 持续高位，优先排查异常流量或死循环任务。",
      "metadata": {
        "scopeKey": "direct_hook_alert_highcpu_host-a"
      }
    },
    "error": null,
    "callback": {
      "url": "https://platform.example.com/api/agent/callback",
      "timeout_ms": 10000,
      "max_retries": 2,
      "retry_delay_ms": 1000,
      "attempts": 1,
      "delivered": true,
      "last_attempt_at": "2026-04-03T02:16:08.650Z",
      "delivered_at": "2026-04-03T02:16:08.700Z"
    }
  }
}
```

说明：

- 查询接口不会返回 `callback.token`
- 若任务不存在，返回 `404`
- 若回调投递失败，可通过 `task.callback.last_error` 查看最近一次投递错误
## 8. 并发与隔离

- 同一个 `session_key`：串行执行，避免同类事件并发污染上下文。
- 不同 `session_key`：可并行，但受 `hooks.maxConcurrentTasks` 限制。
- 任务结果默认回调平台，不直接推送钉钉。

## 9. 可观测性

Hook 服务日志单独写入：

```text
logs/hooks/hooks-server-YYYY-MM-DD.log
```

当前会记录：

- 请求接收
- 幂等命中
- 任务开始/成功/失败
- 回调成功/重试/失败
- 关闭时 drain 行为

## 10. 建议实践

- 平台使用稳定的 `request_id`，保证重试安全。
- 平台按业务实体设计 `session_key`，例如 `alert:<fingerprint>`。
- 钉钉通知留在平台侧，Agent 只负责分析和回调。
- `prompt` 可以由平台传入，但建议逐步沉淀成固定模板或 skill 约束，减少输出漂移。
