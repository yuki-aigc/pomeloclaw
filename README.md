# DeepAgents Bot

一个基于 DeepAgentsJS 的智能助手，参考了OpenClaw的设计理念。具有自主记忆和SKILLS编写/执行能力。

## 特性

- 🧠 **记忆系统**: 每日/长期记忆写入与检索，支持自动记忆 flush
- 🧹 **上下文压缩**: 自动/手动压缩对话历史，展示 token 使用情况
- 🛠️ **技能系统**: SKILL.md 定义技能，动态加载与子代理协作
- 🔌 **MCP 集成**: 支持通过 `@langchain/mcp-adapters` 挂载 MCP 工具（stdio / http(sse)）
- 🤖 **模型提供商**: 支持 OpenAI / Anthropic（通过配置切换）
- 💬 **交互模式**: CLI 对话 + DingTalk Stream 机器人模式
- 🧾 **命令执行**: 白名单命令执行，支持审批与超时/输出限制
- 📁 **文件读写**: 工作区文件系统读写，支撑记忆与技能存储

## 快速开始
  
### 1. 安装依赖

```bash
pnpm install
# 若要使用 Anthropic 提供商，请额外安装：
pnpm add @langchain/anthropic
```

### 2. 配置

```bash
cp config-example.json config.json
# Qwen Code配置。这里建议让Agent使用CC等专业CLI工具生成代码。所谓术业有专攻，Agent本身并不是专业的Coding专家。
cp .qwen/config/settings_example.json ~/.qwen/settings.json
```

编辑 `config.json`：

```json
{   
    "llm": {
        "default_model": "default_model", // 默认模型别名
        "models": [ // 多模型配置池，可通过 /model <别名> 实时切换
            {
                "alias": "default_model",
                "provider": "openai",
                "base_url": "https://api.openai.com/v1",
                "model": "gpt-4o",
                "api_key": "",
                "max_retries": 3
            },
            {
                "alias": "claude35",
                "provider": "anthropic",
                "base_url": "https://api.anthropic.com",
                "model": "claude-3-5-sonnet-latest",
                "api_key": "",
                "headers": { // 可选，按模型透传自定义请求头
                    "anthropic-version": "2023-06-01"
                },
                "max_retries": 3
            }
        ]
    },
    "agent": {
        "workspace": "./workspace", // 工作区目录
        "skills_dir": "./workspace/skills", //SKILLS目录
        "recursion_limit": 50, // 递归限制, LangChain防止Agent无限循环的一道锁。可以适当提高
        "compaction": { // 上下文压缩配置
            "enabled": true, // 是否开启上下文压缩
            "auto_compact_threshold": 80000, // 自动压缩阈值
            "context_window": 128000, // 上下文窗口
            "reserve_tokens": 20000, // 保留token，防止压缩后丢失重要信息
            "max_history_share": 0.5 // 历史共享比例，0.5表示保留50%的历史记录
        }
    },
    "exec": {
        "enabled": true, //是否开启命令行模式
        "commandsFile": "./exec-commands.json", // 命令行白名单文件
        "defaultTimeoutMs": 30000, // 命令行超时时间
        "maxOutputLength": 50000, // 命令行输出最大长度
        "approvals": {
            "enabled": true // 是否允许执行命令行审批
        }
    },
    "mcp": {
        "enabled": false, // 是否启用 MCP 工具
        "throwOnLoadError": true, // 工具加载失败时是否直接报错
        "prefixToolNameWithServerName": true, // 工具名是否加 server 前缀
        "additionalToolNamePrefix": "", // 额外前缀
        "useStandardContentBlocks": false,
        "onConnectionError": "throw", // throw 或 ignore
        "servers": {
            "filesystem": { // stdio 示例
                "transport": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"]
            },
            "weather": { // http/sse 示例
                "transport": "sse",
                "url": "https://example.com/mcp/sse",
                "headers": {
                    "Authorization": "Bearer YOUR_TOKEN"
                },
                "automaticSSEFallback": true
            }
        }
    },
    "cron": {
        "enabled": true, // 是否启用定时任务调度
        "store": "./workspace/cron/jobs.json", // 定时任务持久化存储
        "timezone": "Asia/Shanghai", // 默认时区
        "runLog": "./workspace/cron/runs.jsonl" // 运行日志（JSONL）
    },
    "dingtalk": {
        "enabled": false, //是否开启钉钉机器人
        "clientId": "", // 钉钉clientId
        "clientSecret": "", // 钉钉clientSecret
        "robotCode": "", // 钉钉robotCode
        "corpId": "", // 钉钉corpId
        "agentId": "", // 钉钉agentId
        "messageType": "card", // 钉钉消息类型，markdown或card
        "cardTemplateId": "", // 钉钉卡片模板ID
        "showThinking": true, // 是否显示思考过程
        "debug": false, // 是否开启调试
        "voice": {
            "enabled": true, // 是否启用语音输入
            "requireRecognition": true, // 语音消息必须有钉钉识别文本，否则提示重试
            "prependRecognitionHint": true // 传给模型前是否加“用户语音转写”前缀
        },
        "cron": {
            "defaultTarget": "cidxxxxxxxxxxxx", // 默认发送到该群聊（openConversationId）
            "useMarkdown": true, // 定时任务推送是否用 markdown
            "title": "SREBot 定时任务" // 默认推送标题
        },
        "execApprovals": {
            "enabled": false, // 是否允许执行命令行审批
            "mode": "button", // 审批模式，text或button
            "templateId": "", // 审批卡片模板ID
            "timeoutMs": 300000 // 审批超时时间
        }
    }
}
```

### MCP 配置说明

- `servers.<name>.transport = "stdio"`: 本地子进程模式，必须配置 `command`，可选 `args/env/cwd/restart`。
- `servers.<name>.transport = "http"`: 走 Streamable HTTP，可配 `url/headers/reconnect`。
- `servers.<name>.transport = "sse"`: 走 SSE，可配 `url/headers/reconnect`。
- `automaticSSEFallback`: 对 `http`/`sse` 连接启用自动降级。
- MCP 工具会自动注入主 Agent 工具列表，CLI 和 DingTalk 模式都会生效。

命令白名单在 `exec-commands.json` 中维护，该配置也建议外挂并持久化：

```json
{
  "allowedCommands": ["ls", "ps", "kubectl", "docker"],
  "deniedCommands": ["rm", "sudo"]
}
```

或使用环境变量：

```bash
# 指定当前模型别名（优先级高于 default_model）
export LLM_MODEL_ALIAS="default_model"

# 可选：按 provider 自动选择模型（仅当未指定 LLM_MODEL_ALIAS）
export LLM_PROVIDER="openai"  # 或 anthropic

# OpenAI
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="gpt-4o"
export OPENAI_BASE_URL="https://api.openai.com/v1"

# Anthropic
export ANTHROPIC_API_KEY="your-api-key"
export ANTHROPIC_MODEL="claude-3-5-sonnet-latest"
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
```

`llm.models[]` 额外支持：
- `headers`: 自定义请求头（例如 `anthropic-version`）

### 3. 运行

```bash
# 命令行模式
pnpm dev
# 钉钉机器人模式（服务端模式）
pnpm dingtalk
```

## 项目结构

```
deepagents_srebot/
├── src/
│   ├── index.ts                 # CLI 入口
│   ├── dingtalk.ts              # DingTalk 入口
│   ├── agent.ts                 # 主代理创建
│   ├── config.ts                # 配置加载
│   ├── mcp.ts                   # MCP 工具加载与连接管理
│   ├── cron/                    # 定时任务调度与工具
│   ├── commands/                # 斜杠命令 /new /compact /status
│   ├── compaction/              # 压缩与摘要
│   ├── middleware/              # 记忆加载/flush
│   ├── subagents/               # 子代理（skill-writer-agent）
│   ├── tools/                   # exec 工具与策略
│   └── channels/
│       └── dingtalk/            # 钉钉消息处理与审批
├── workspace/
│   ├── MEMORY.md                # 长期记忆
│   ├── memory/                  # 每日记忆
│   └── skills/                  # 技能目录（SKILL.md）
├── config.json                  # 主配置
├── exec-commands.json           # 命令白名单/黑名单
└── package.json
```

## 使用示例

### 记忆 + 压缩

```
你: 请记住我叫小S，是一名 SRE 工程师
助手: 已保存到长期记忆

你: /status
助手: 会话状态 ... Token 使用 ... 自动压缩阈值 ...

你: /compact 只保留关键决策
助手: 上下文压缩完成 ...

你: /models
助手: 展示已配置模型列表（含当前激活模型）

你: /model claude35
助手: 已切换到 claude35
```

### 定时任务（DingTalk）

```
你: 每天早上 9 点给群里推送昨晚告警摘要
助手: 已创建 cron 任务（返回任务 id、下一次执行时间）

你: 把这个任务改成工作日 10:30
助手: 已更新任务调度

你: 列出所有定时任务
助手: 返回任务列表（id、调度、目标、下次执行）
```

- 定时任务通过模型调用 `cron_job_*` 工具完成增删改查。
- 若未显式指定发送目标，会优先使用当前会话（群聊用 `conversationId`，私聊用 `senderId`）。
- 可在 `config.json` 中配置 `dingtalk.cron.defaultTarget`，让任务默认发到固定群（`openConversationId`，通常以 `cid` 开头）。

### 技能编写子代理

```
你: 帮我创建一个天气查询的技能
助手: 已调用 skill-writer-agent 创建 workspace/skills/weather-query/SKILL.md
```

### 命令执行（白名单 + 审批）

```
你: 执行 kubectl get events -A
助手: 触发审批 ... 执行完成并返回结果
```

### DingTalk 机器人

```
pnpm dingtalk
```

- 需要在[钉钉开发者后台](https://open-dev.dingtalk.com/fe/card) 开启消息卡片功能。在本项目template中提供了两个卡片模板，可以导入使用。
- 语音输入默认使用钉钉上行消息里的 `recognition` 字段（语音转文字结果）。
- 可在钉钉会话中使用 `/voice` 查看状态，`/voice on` 或 `/voice off` 实时切换语音输入开关。
- 图片会自动做视觉理解；文件会尝试抽取文本内容；视频会尝试抽帧并生成摘要（需本机安装 `ffmpeg/ffprobe`）。
- 在应用的权限管理页面，需要开启以下权限：
  - ✅ Card.Instance.Write — 创建和投放卡片实例
  - ✅ Card.Streaming.Write — 对卡片进行流式更新
- **注意钉钉应用机器人需要配置可见人员并发布**

## 关于容器部署
```bash
#  构建并推送镜像（注意：Mac 用户需要指定 --platform linux/amd64）
docker build --platform linux/amd64 -f deploy/Dockerfile -t your-registry/deepagents-srebot:latest .
docker push your-registry/deepagents-srebot:latest
#  K8S部署：创建 Secret（也可以手动base64）
kubectl create secret generic deepagents-srebot-config \
  --from-file=config.json=./config.json

#  部署，需要持久化workspace目录（主要是记忆，SKILLS关键目录）。见PVC相关配置
kubectl apply -f deploy/deploy-all.yaml
```

## 后续尽快支持功能。。。

> 以下为优先级较高的功能，其余功能会随着OpenClaw官方库的迭代逐步更新。

- [ ] Memory机制支持混合检索架构，采用SQLite或Milvus+Mysql(还没想好，可能都支持)。实现语义搜索和关键词检索。
- [ ] 支持独立记忆模式，支持主会话/群聊的记忆隔离。
- [ ] 支持sandbox机制，支持沙盒环境下的命令执行(这里可能先由K8S实现)。

## 许可证

MIT
