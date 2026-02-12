<p align="center">
  <img src="docs/Pomelobot.png" alt="Pomelobot" width="280" />
</p>

<h1 align="center">Pomelobot</h1>

<p align="center">
  基于 <a href="https://github.com/DeepAgentsAI/DeepAgentsJS">DeepAgentsJS</a> + <a href="https://github.com/langchain-ai/langgraphjs">LangGraph</a> 构建的智能助手，参考了 OpenClaw 的设计理念。<br/>
  具备自主记忆、SKILL 编写/执行、定时任务调度和多渠道接入能力。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Node.js_≥20-green?logo=node.js" />
  <img src="https://img.shields.io/badge/lang-TypeScript-blue?logo=typescript" />
  <img src="https://img.shields.io/badge/license-MIT-yellow" />
</p>

---

## 特性

| 能力 | 说明 |
|------|------|
| 🧠 **记忆系统** | PGSQL 增量索引（可回退文件模式），支持 FTS / Vector / Hybrid 检索与会话隔离 |
| 🧩 **冷启动记忆** | DingTalk 会话首轮可注入“今天/昨天”Markdown 摘要（有注入限额，避免 token 膨胀） |
| ⚡ **会话向量召回** | `dingtalk_session_events` 向量异步回填 + PG 内 ANN 检索，失败自动回退 FTS / temporal |
| ♻️ **会话TTL治理** | `dingtalk_session_events` 支持按 TTL 自动清理，控制历史体量与检索成本 |
| 🧹 **上下文压缩** | 自动 / 手动压缩对话历史，实时展示 Token 使用情况 |
| 🛠️ **技能系统** | 以 `SKILL.md` 定义技能，动态加载并通过子代理协作 |
| 🔌 **MCP 集成** | 通过 `@langchain/mcp-adapters` 挂载 MCP 工具（stdio / http / sse） |
| 🤖 **多模型支持** | OpenAI / Anthropic（多模型配置池，运行时 `/model` 热切换） |
| 🌉 **渠道网关** | 引入 `GatewayService + ChannelAdapter` 抽象，已接入 DingTalk + iOS WebSocket，支持后续扩展飞书 / 安卓等渠道 |
| ⏰ **定时任务** | Cron 调度，支持持久化、JSONL 运行日志、群聊 / 私聊推送；启动时幂等确保 04:00 每日记忆归档任务 |
| 🧾 **命令执行** | 白名单 / 黑名单策略 + 审批机制，超时与输出长度限制 |
| 📁 **文件读写** | 基于 `FilesystemBackend` 的工作区文件系统，支撑记忆与技能存储 |
| 🔍 **审计日志** | 命令执行全链路审计（策略判定、审批决策、执行结果） |

## 快速开始

### 环境要求

- **Node.js** >= 20
- **pnpm**（推荐）
- 可选：Docker、kubectl（用于容器化部署）

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置

```bash
cp config-example.json config.json
```

编辑 `config.json`，按需填写模型 API Key 及各模块配置，完整字段说明见下方 [配置说明](#配置说明)。

### 3. 运行

```bash
# CLI 交互模式
pnpm dev

# DingTalk 机器人模式
pnpm dingtalk

# iOS WebSocket 模式
pnpm ios

# 统一服务端（多渠道入口，按 config/CHANNELS 启动）
pnpm run server
```

多渠道启动方式（当前已实现 dingtalk + ios）：

```bash
# 启动 config.json 中所有 enabled 渠道
pnpm run server

# 按环境变量显式指定渠道（逗号分隔）
CHANNELS=dingtalk pnpm run server
CHANNELS=ios pnpm run server
CHANNELS=dingtalk,ios pnpm run server

# 生产建议：先构建再运行统一入口
pnpm build
pnpm start:server
```

> 提示：`pnpm server` 是 pnpm 自带命令，项目脚本请使用 `pnpm run server`（或别名 `pnpm channels`）。

日志说明（统一服务端）：

- 服务端日志：`logs/server-YYYY-MM-DD.log`
- 钉钉通道日志：`logs/dingtalk-server-YYYY-MM-DD.log`
- iOS 通道日志：`logs/ios-server-YYYY-MM-DD.log`

## 文档导航

- [Memory 机制说明](docs/memory.md)
- [Compaction 机制说明](docs/compaction.md)
- [Memory + Compaction 流程图](docs/architecture-memory-compaction.md)
- [渠道网关设计](docs/channel-gateway.md)
- [容器与部署说明](docs/deployment-container.md)

## 项目结构

```
pomelobot/
├── src/
│   ├── index.ts                 # CLI 入口
│   ├── dingtalk.ts              # DingTalk 入口
│   ├── ios.ts                   # iOS WebSocket 入口
│   ├── server.ts                # 多渠道统一服务端入口
│   ├── agent.ts                 # 主代理创建与工具注册
│   ├── config.ts                # 配置加载与类型定义
│   ├── llm.ts                   # 多模型管理（OpenAI / Anthropic）
│   ├── mcp.ts                   # MCP 工具加载与连接管理
│   ├── log/
│   │   └── runtime.ts           # 运行时日志落盘（logs/*.log）
│   ├── audit/
│   │   └── logger.ts            # 命令执行审计日志
│   ├── commands/
│   │   ├── commands.ts          # /new /compact /status /model 等斜杠命令
│   │   └── index.ts
│   ├── compaction/
│   │   ├── compaction.ts        # 上下文压缩核心逻辑
│   │   ├── summary.ts           # 摘要生成
│   │   └── index.ts
│   ├── cron/
│   │   ├── tools.ts             # cron_job_* 工具定义
│   │   ├── service.ts           # 调度服务
│   │   ├── schedule.ts          # Cron 调度器
│   │   ├── store.ts             # 任务持久化
│   │   ├── runtime.ts           # 运行时管理
│   │   └── types.ts
│   ├── middleware/
│   │   ├── memory.ts            # 记忆上下文加载
│   │   ├── memory-flush.ts      # 记忆自动 flush
│   │   └── index.ts
│   ├── subagents/
│   │   └── index.ts             # 子代理（skill-writer-agent）
│   ├── tools/
│   │   ├── exec.ts              # 命令执行核心
│   │   ├── exec-policy.ts       # 白名单 / 黑名单策略与风险评估
│   │   ├── command-parser.ts    # 命令解析
│   │   └── index.ts
│   └── channels/
│       ├── context.ts           # 渠道无关会话上下文
│       ├── gateway/
│       │   ├── service.ts       # GatewayService（注册/分发/去重）
│       │   └── types.ts         # ChannelAdapter/消息模型
│       ├── dingtalk/
│       │   ├── adapter.ts       # DingTalk ChannelAdapter
│       │   ├── handler.ts       # 消息处理（文本 / 语音 / 图片 / 文件）
│       │   ├── client.ts        # DingTalk Stream 客户端
│       │   ├── approvals.ts     # 命令执行审批（文本 / 按钮模式）
│       │   ├── context.ts       # 会话上下文管理
│       │   └── types.ts
│       └── ios/
│           ├── adapter.ts       # iOS WebSocket ChannelAdapter
│           └── types.ts         # iOS 消息协议类型
├── workspace/
│   ├── MEMORY.md                # 长期记忆
│   ├── memory/                  # 每日记忆目录
│   ├── skills/                  # 技能目录（每个技能含 SKILL.md）
│   └── cron/                    # 定时任务存储与运行日志
├── template/
│   └── dingtalk-card/           # DingTalk 消息卡片模板（可直接导入）
├── deploy/
│   ├── Dockerfile               # 容器镜像构建
│   ├── docker-compose.yaml      # 本地 PG 依赖部署（可选）
│   └── k8s/
│       ├── deploy-all.yaml      # 应用部署清单（Deployment + PVC + Secret）
│       └── sts.yaml             # PG StatefulSet 示例
├── docs/                        # 文档与资源
├── config-example.json          # 配置示例
├── exec-commands.json           # 命令白名单 / 黑名单
├── tsconfig.json
└── package.json
```

## 配置说明

配置文件为项目根目录下的 `config.json`，以下为各模块的完整字段说明。

### LLM 多模型配置

支持配置多个模型，运行时通过 `/model <别名>` 热切换。

```jsonc
{
    "llm": {
        "default_model": "default_model", // 默认激活的模型别名
        "models": [
            {
                "alias": "default_model",      // 模型别名（用于 /model 切换）
                "provider": "openai",           // 提供商：openai | anthropic
                "base_url": "https://api.openai.com/v1",
                "model": "gpt-4o",
                "api_key": "sk-xxx",
                "max_retries": 3
            },
            {
                "alias": "claude35",
                "provider": "anthropic",
                "base_url": "https://api.anthropic.com",
                "model": "claude-3-5-sonnet-latest",
                "api_key": "sk-ant-xxx",
                "headers": {                    // 可选，按模型透传自定义请求头
                    "anthropic-version": "2023-06-01"
                },
                "max_retries": 3
            }
        ]
    }
}
```

也可通过环境变量覆盖：

```bash
export LLM_MODEL_ALIAS="default_model"   # 指定激活模型别名
export OPENAI_API_KEY="sk-xxx"
export OPENAI_MODEL="gpt-4o"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

### Agent 核心配置

```jsonc
{
  "agent": {
    "workspace": "./workspace",           // 工作区根目录
    "skills_dir": "./workspace/skills",   // 技能目录
    "recursion_limit": 50,                // LangGraph 递归上限（防止无限循环）
    "compaction": {
      "enabled": true,                  // 是否开启上下文压缩
      "auto_compact_threshold": 80000,  // 自动压缩阈值（tokens）
      "context_window": 128000,         // 模型上下文窗口大小
      "reserve_tokens": 20000,          // 压缩后保留的 token 数
      "max_history_share": 0.5          // 历史保留比例
    },
    "memory": {
      "backend": "pgsql",               // filesystem | pgsql
      "pgsql": {
        "enabled": true,
        "connection_string": "",      // 推荐通过环境变量 MEMORY_PG_CONNECTION_STRING 注入
        "host": "127.0.0.1",
        "port": 5432,
        "user": "pomelobot",
        "password": "",
        "database": "pomelobot",
        "ssl": false,
        "schema": "pomelobot_memory"
      },
      "retrieval": {
        "mode": "hybrid",             // keyword | fts | vector | hybrid
        "max_results": 8,
        "min_score": 0.1,
        "sync_on_search": true,
        "sync_min_interval_ms": 20000,
        "hybrid_vector_weight": 0.6,
        "hybrid_fts_weight": 0.4,
        "hybrid_candidate_multiplier": 2,
        "include_session_events": true,   // 是否把 dingtalk_session_events 纳入统一检索
        "session_events_max_results": 6,  // 每次检索最多合并多少条 session events
        "session_events_vector_async_enabled": true,
        "session_events_vector_async_interval_ms": 5000,
        "session_events_vector_async_batch_size": 16,
        "session_events_ttl_days": 30,
        "session_events_ttl_cleanup_interval_ms": 600000
      },
      "embedding": {
        "enabled": true,              // 关闭后自动退化为非向量检索
        "cache_enabled": true,
        "providers": [
          {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "api_key": ""
          }
        ]
      },
      "session_isolation": {
        "enabled": true,
        "direct_scope": "main",       // main | direct
        "group_scope_prefix": "group_"
      },
      "transcript": {
        "enabled": false
      }
    }
  }
}
```

### 命令执行

```jsonc
{
    "exec": {
        "enabled": true,
        "commandsFile": "./exec-commands.json",  // 白名单 / 黑名单文件
        "defaultTimeoutMs": 30000,                // 默认超时（ms）
        "maxOutputLength": 50000,                 // 输出最大长度
        "approvals": {
            "enabled": true                       // 是否开启执行审批
        }
    }
}
```

命令白名单文件 `exec-commands.json`：

```json
{
    "allowedCommands": ["ls", "cat", "grep", "kubectl", "docker", "git", "curl"],
    "deniedCommands": ["rm", "mv", "chmod", "chown", "sudo", "su"]
}
```

### MCP 工具

```jsonc
{
    "mcp": {
        "enabled": false,
        "throwOnLoadError": true,
        "prefixToolNameWithServerName": true,
        "servers": {
            "filesystem": {                       // stdio 模式
                "transport": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "${MCP_FS_ROOT}"],
                "env": { "MCP_FS_ROOT": "./workspace" }
            },
            "weather": {                          // SSE 模式
                "transport": "sse",
                "url": "https://example.com/mcp/sse",
                "headers": { "Authorization": "Bearer ${WEATHER_API_TOKEN}" },
                "env": { "WEATHER_API_TOKEN": "YOUR_TOKEN" },
                "automaticSSEFallback": true
            }
        }
    }
}
```

> - `transport` 支持 `stdio`、`http`、`sse` 三种模式
> - 每个 `mcp.servers.<name>` 都支持 `env`，并可在同一 server 的字符串字段里使用 `${VAR}` 占位符
> - MCP 工具会自动注入主 Agent 工具列表，CLI / DingTalk / iOS 模式均可使用

### 定时任务

```jsonc
{
    "cron": {
        "enabled": true,
        "store": "./workspace/cron/jobs.json",    // 任务持久化文件
        "timezone": "Asia/Shanghai",
        "runLog": "./workspace/cron/runs.jsonl"   // 运行日志（JSONL 格式）
    }
}
```

### DingTalk 机器人

```jsonc
{
    "dingtalk": {
        "enabled": false,
        "clientId": "",
        "clientSecret": "",
        "robotCode": "",
        "corpId": "",
        "agentId": "",
        "messageType": "card",              // 消息类型：card | markdown
        "cardTemplateId": "",               // 消息卡片模板 ID
        "showThinking": true,               // 是否展示思考过程
        "debug": false,
        "voice": {
            "enabled": true,                // 启用语音输入
            "requireRecognition": true,     // 要求钉钉识别文本，否则提示重试
            "prependRecognitionHint": true  // 传给模型前加"用户语音转写"前缀
        },
        "cron": {
            "defaultTarget": "cidxxxx",     // 定时任务默认推送群（openConversationId）
            "useMarkdown": true,
            "title": "Pomelobot 定时任务",
            "autoMemorySaveAt4": true       // 启动时幂等确保 04:00 每日记忆归档任务
        },
        "execApprovals": {
            "enabled": false,               // 是否开启命令审批
            "mode": "button",               // 审批模式：text | button
            "templateId": "",               // 审批卡片模板 ID
            "timeoutMs": 300000
        }
    }
}
```

### iOS WebSocket

```jsonc
{
    "ios": {
        "enabled": false,
        "host": "0.0.0.0",
        "port": 18080,
        "path": "/ws/ios",
        "authToken": "",                   // 可选：用于 hello 认证
        "debug": false,
        "maxPayloadBytes": 1048576,
        "pingIntervalMs": 30000,
        "cron": {
            "defaultTarget": "conversation:ios-default", // 默认推送目标
            "useMarkdown": false,
            "title": "iOS 定时任务",
            "store": "./workspace/cron/ios-jobs.json",
            "runLog": "./workspace/cron/ios-runs.jsonl"
        }
    }
}
```

> iOS target 约定：`conversation:<id>` / `user:<id>` / `connection:<id>`，无前缀时按 conversationId 解析。

## 斜杠命令

在 CLI 交互模式下，支持以下命令：

| 命令 | 说明 |
|------|------|
| `/new` | 开始新会话（清空上下文，退出前自动 flush 记忆） |
| `/compact [说明]` | 手动压缩上下文（可附加压缩重点说明） |
| `/models` | 列出已配置的模型列表（含当前激活标记） |
| `/model <别名>` | 热切换当前模型 |
| `/status` | 显示会话状态（Token 用量、模型信息、上下文占比等） |
| `/help` | 显示帮助信息 |

## 使用示例

### 记忆 + 上下文压缩

```
你: 请记住我叫小S，是一名 SRE 工程师
助手: 已保存到长期记忆

你: /status
助手: 🤖 Pomelobot v1.0.0
      🧠 Model: openai/gpt-4o ...
      🧮 Tokens: 1.2k in / 0.8k out ...

你: /compact 只保留关键决策
助手: 🧹 上下文压缩完成。压缩前: 12.5k → 压缩后: 3.2k，节省 9.3k tokens
```

### 定时任务（DingTalk）

```
你: 每天早上 9 点给群里推送昨晚告警摘要
助手: 已创建 cron 任务（ID: xxx，下一次执行: 明天 09:00）

你: 把这个任务改成工作日 10:30
助手: 已更新任务调度 → 0 30 10 * * 1-5

你: 列出所有定时任务
助手: [任务列表：ID、调度表达式、目标、下次执行时间]
```

### 技能编写

```
你: 帮我创建一个告警根因分析的技能
助手: 已调用 skill-writer-agent 创建 workspace/skills/alert-rca/SKILL.md
```

### 命令执行（白名单 + 审批）

```
你: 帮我看下集群里的 Pod 状态
助手: [exec_command] kubectl get pods -A
      ● Exec 审批
      命令: kubectl get pods -A
      风险: low
      允许执行? (y=允许, n=拒绝, e=编辑) y
      ✅ Command executed successfully
      📤 Output: ...
```

### 模型切换

```
你: /models
助手: • default_model (openai) -> gpt-4o
        claude35 (anthropic) -> claude-3-5-sonnet-latest

你: /model claude35
助手: ✅ 已切换模型: claude35 (claude-3-5-sonnet-latest)
```

## DingTalk 机器人

```bash
pnpm dingtalk
```

### 功能支持

- **消息卡片**：需在[钉钉开发者后台](https://open-dev.dingtalk.com/fe/card)开启消息卡片功能，`template/dingtalk-card/` 中提供了可直接导入的卡片模板
- **语音输入**：使用钉钉上行消息的 `recognition` 字段（语音转文字），可通过 `/voice on|off` 控制开关
- **多媒体处理**：图片自动视觉理解；文件尝试文本抽取；视频抽帧摘要（需安装 `ffmpeg`）
- **文件回传**：优先通过 `dingtalk_write_tmp_file` / `dingtalk_send_file` 工具触发（稳定），文件统一落到 `workspace/tmp/`；同时兼容 `<dingtalk-file ...>` / `FILE_OUTPUT:` 文本标记（单文件 ≤ 10MB）
- **定时推送**：通过 `cron_job_*` 工具管理定时任务，支持群聊 / 私聊推送
- **首轮记忆注入**：会话首轮自动注入今天/昨天 Markdown 摘要（受限额控制，不读取向量库）
- **自动归档任务**：启动时幂等确保 04:00 的 daily memory_save 任务（可通过 `dingtalk.cron.autoMemorySaveAt4=false` 关闭）
- **斜杠命令**：支持 `/status`、`/models`、`/model <alias>`、`/voice`、`/voice on|off`、`/help`、`/?`

### 所需权限

- ✅ Card.Instance.Write — 创建和投放卡片实例
- ✅ Card.Streaming.Write — 对卡片进行流式更新

> **注意**：钉钉应用机器人需要配置可见人员并发布后才可使用。

## iOS WebSocket 服务

```bash
pnpm ios

# 或统一入口
CHANNELS=ios pnpm run server
```

### 协议要点

- 客户端连接后先发 `hello`（可带 `authToken`）完成会话初始化
- 用户消息使用 `type=message`，最少包含 `text`，其余字段可由服务端自动补全
- 服务端回复 `type=reply`，主动推送为 `type=proactive`
- iOS 定时任务推送目标支持：`conversation:<id>` / `user:<id>` / `connection:<id>`

## 容器部署

### 构建镜像

```bash
# Mac 用户需指定 --platform linux/amd64
docker build --platform linux/amd64 -f deploy/Dockerfile -t your-registry/pomelobot:latest .
docker push your-registry/pomelobot:latest
```

### K8s 部署

```bash
# 创建 Secret（存储 config.json）
kubectl create secret generic deepagents-srebot-config \
  --from-file=config.json=./config.json

# 部署（需持久化 workspace 目录，包含记忆与技能数据）
kubectl apply -f deploy/k8s/deploy-all.yaml
```

> 部署清单包含 Deployment、PVC、Secret 等资源定义，详见 `deploy/k8s/deploy-all.yaml`。

## Roadmap

- [x] Memory 混合检索架构：PGSQL + FTS（增量索引），可选 Vector/Hybrid
- [x] 独立记忆模式：支持主会话 / 群聊的记忆隔离（direct 可选独立 scope）
- [ ] Sandbox 机制：沙盒环境下的命令执行（优先基于 K8s 实现）

## 许可证

[MIT](LICENSE)
