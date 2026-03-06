# 命令与运行方式

本文档统一说明 Pomelobot 的启动命令、各渠道可用的斜杠命令，以及技能安装相关约束。

## 1. 终端启动命令

### 1.1 开发模式

| 命令 | 作用 |
|------|------|
| `pnpm dev` | 启动 CLI 交互模式 |
| `pnpm dingtalk` | 启动 DingTalk 渠道 |
| `pnpm ios` | 启动 iOS WebSocket 渠道 |
| `pnpm web` | 启动 Web UI + WebSocket 渠道 |
| `pnpm run server` | 启动统一服务端，按配置或 `CHANNELS` 环境变量加载渠道 |
| `pnpm channels` | `pnpm run server` 的别名 |

### 1.2 生产模式

| 命令 | 作用 |
|------|------|
| `pnpm build` | 编译 TypeScript 到 `dist/` |
| `pnpm start` | 启动 CLI 生产模式 |
| `pnpm start:server` | 启动统一服务端生产模式 |
| `pnpm start:ios` | 启动 iOS 渠道生产模式 |
| `pnpm start:web` | 启动 Web 渠道生产模式 |
| `pnpm typecheck` | 执行类型检查 |
| `pnpm test` | 运行测试 |

### 1.3 多渠道启动示例

```bash
pnpm run server
CHANNELS=dingtalk pnpm run server
CHANNELS=ios pnpm run server
CHANNELS=web pnpm run server
CHANNELS=dingtalk,ios,web pnpm run server
```

注意：`pnpm server` 会和 pnpm 自带命令冲突，项目脚本请使用 `pnpm run server`。

## 2. 斜杠命令渠道矩阵

| 命令 | CLI | DingTalk | Web | iOS | 说明 |
|------|-----|----------|-----|-----|------|
| `/new` | ✅ | - | - | - | 新建会话 |
| `/reset` | ✅ | - | - | - | `/new` 的兼容别名 |
| `/compact [说明]` | ✅ | - | - | - | 手动压缩上下文 |
| `/models` | ✅ | ✅ | ✅ | - | 查看模型列表 |
| `/model <别名>` | ✅ | ✅ | ✅ | - | 切换当前模型 |
| `/status` | ✅ | ✅ | ✅ | - | 查看会话与运行时状态 |
| `/skills` | ✅ | ✅ | ✅ | ✅ | 查看已安装技能 |
| `/skill-install <来源>` | ✅ | ✅ | ✅ | ✅ | 安装技能 |
| `/skill-remove <名称>` | ✅ | ✅ | ✅ | ✅ | 删除技能 |
| `/skill-reload` | ✅ | ✅ | ✅ | ✅ | 强制重载技能索引 |
| `/voice` | - | ✅ | ⚠️ | - | DingTalk 查看语音输入状态；Web 仅提示不支持 |
| `/voice on` / `/voice off` | - | ✅ | ⚠️ | - | DingTalk 开关语音输入；Web 仅提示不支持 |
| `/help` / `/?` | ✅ | ✅ | ✅ | - | 显示帮助 |

说明：
- iOS 当前只接入了技能管理类斜杠命令，未接入 `/status`、`/models`、`/model`、`/help`。
- Web 会对 `/voice` 返回明确的“不支持”提示，不会静默无响应。
- CLI、DingTalk、Web 对未识别的斜杠命令会直接返回错误提示，不进入 Agent 对话。
- iOS 只拦截技能管理类斜杠命令；其他 `/xxx` 输入当前仍会按普通对话进入 Agent。

## 3. 命令详解

### 3.1 会话与上下文

#### `/new`

仅 CLI 支持。创建新的 `thread_id`，后续对话与旧会话上下文隔离。

```text
/new
```

#### `/reset`

仅 CLI 支持，是 `/new` 的兼容别名。

```text
/reset
```

#### `/compact [说明]`

仅 CLI 支持。立即执行一次上下文压缩；可附带本次压缩重点。

```text
/compact
/compact 只保留关键决策和待办
```

### 3.2 模型管理

#### `/models`

列出当前配置文件中的全部模型，并标记当前激活模型。

```text
/models
```

#### `/model <别名>`

切换当前运行模型。

```text
/model claude35
/model qwen
```

如果别名不存在，会返回用法提示或错误信息。

#### `/status`

显示会话状态，包括模型、API Key 掩码、Token 计数、上下文占比、压缩次数、线程 ID 与运行模式。

```text
/status
```

### 3.3 技能管理

#### `/skills`

列出当前 `skills_dir` 下已安装的技能。

```text
/skills
```

#### `/skill-install <来源>`

支持以下来源：

- `owner/repo`
- `owner/repo/path/to/skill`
- `https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/main/path/to/skill`
- 本地技能目录，例如 `./workspace/skills/demo-skill`
- 本地 `.skill` / `.zip` 包
- 远程 `.skill` / `.zip` 直链

示例：

```text
/skill-install openclaw/skills/prometheus-analyzer
/skill-install https://github.com/owner/repo/tree/main/skills/demo-skill
/skill-install ./downloads/demo-skill.skill
/skill-install https://example.com/demo-skill.zip
```

安装规则：
- 技能目录内必须存在 `SKILL.md`，且 frontmatter 至少包含 `name` 和 `description`。
- 如果来源路径最后一段和已有技能目录同名，会先删除旧目录，再安装新版本。
- `/skill-install` 完成后会立即触发 Agent 热重载；新技能无需重启进程。
- 对于手工修改 `skills_dir` 下文件的情况，目录监控器会在下一轮请求前触发重载。

已知限制：
- GitHub `tree` URL 的 `ref` 目前按单段分支名解析；如果分支名本身包含 `/`，优先使用默认分支、仓库 shorthand、或 `.skill/.zip` 直链。
- 当 GitHub 仓库或本地目录下存在多个 `SKILL.md` 时，需要显式指定技能子目录。

#### `/skill-remove <名称>`

删除已安装技能。支持按技能名或目录名匹配。

```text
/skill-remove prometheus-analyzer
```

执行后会立即热重载技能索引。

#### `/skill-reload`

强制重建技能索引。适合用于排查技能目录监控未及时触发的情况。

```text
/skill-reload
```

### 3.4 语音输入（DingTalk）

#### `/voice`

查看 DingTalk 语音输入状态。

```text
/voice
```

#### `/voice on`

开启 DingTalk 语音输入。

```text
/voice on
```

#### `/voice off`

关闭 DingTalk 语音输入。

```text
/voice off
```

说明：
- 该命令只对 DingTalk 渠道生效。
- Web 渠道会明确回复“暂不支持”。

### 3.5 帮助

#### `/help`

显示当前渠道支持的命令帮助。

```text
/help
```

#### `/?`

`/help` 的短别名。

```text
/?
```

## 4. 推荐排查顺序

当你发现命令没有生效时，优先检查：

1. 当前渠道是否支持该命令。
2. 进程是否已经重启到最新代码版本。
3. `config.json` 中对应渠道是否启用。
4. 技能类命令是否指向正确的 `agent.skills_dir`。
5. 远程技能安装时，来源是否包含唯一且合法的 `SKILL.md`。
