# Memory 机制说明（Pomelobot）

> 本文档说明 Pomelobot 的记忆机制、检索机制、会话机制与运维要点。

参考：
- [OpenClaw Memory](https://docs.openclaw.ai/zh-CN/concepts/memory)
- [Memory + Compaction 流程图](./architecture-memory-compaction.md)

---

## 1. 什么是 Memory

在本项目里，Memory 不是“把整段历史对话一直塞进上下文”，而是两层机制协同：

1. 会话态记忆（短期）
- DingTalk 模式把 `messageHistory` 持久化到 PG `dingtalk_sessions`，用于重启后恢复会话。

2. 知识型记忆（长期）
- 通过 `memory_save` 写入 Markdown 文件（`daily` / `long-term`），并建立 PG 增量索引。
- 回答历史问题时通过 `memory_search` 按需检索，再用 `memory_get` 按路径/行号精读片段，不依赖静态 system prompt 全量注入。

---

## 2. 记忆文件与存储结构

### 2.1 文件层（可读可审计）

- 主会话长期记忆：`workspace/MEMORY.md`
- 主会话每日记忆：`workspace/memory/YYYY-MM-DD.md`
- 隔离 scope 长期记忆：`workspace/memory/scopes/<scope>/LONG_TERM.md`
- 隔离 scope 每日记忆：`workspace/memory/scopes/<scope>/YYYY-MM-DD.md`
- 会话 transcript：`workspace/memory/scopes/<scope>/transcripts/YYYY-MM-DD.md`

### 2.2 数据库层（检索与恢复）

Schema 默认：`pomelobot_memory`

- `memory_files`：索引文件元数据（mtime/size/hash）
- `memory_chunks`：分块内容、FTS、可选向量 embedding
- `embedding_cache`：embedding 缓存
- `dingtalk_sessions`：会话状态（messageHistory + token 计数）
- `session_events`：会话事件热日志（user/assistant/summary，供 DingTalk / Web 共用）

---

## 3. 什么时候会写入记忆

### 3.1 显式保存（强语义）

Agent 调用 `memory_save` 时：
- `target=daily` -> 当日记忆文件
- `target=long-term` -> 长期记忆文件

写入后会触发单文件增量索引。

### 3.2 压缩前自动 flush（防丢关键事实）

当会话 token 接近阈值时，系统先触发 memory flush：
- 注入强约束提示，要求模型调用 `memory_save`
- 摘要必须使用固定结构保存“进行中工作态”（当前任务 / 最新用户请求 / 已完成进展 / 进行中工作 / 待办与后续承诺 / 关键决策与约束 / 未解决问题与风险）
- 摘要保存后返回 `NO_REPLY`
- 再进入 compaction

### 3.3 渠道会话热日志与 transcript

- DingTalk：每条 user/assistant 消息优先写入 `session_events`；PG 不可用时降级写 transcript 文件；compaction 完成后会把 `summary` 也记为事件。
- Web：每条 user/assistant 消息会同时写 transcript 文件，并尽量写入 `session_events`，用于多用户 API 场景下的热日志回溯。
- Web 会在单会话 token 达阈值后后台执行 memory flush，把“进行中工作态摘要”写入 `daily` 记忆，并轮换 thread_id。

### 3.4 进程退出（SIGINT/SIGTERM）

DingTalk 进程在优雅退出时会：
1. 等待在途会话处理队列
2. 对活跃 session 尝试执行 shutdown flush
3. 持久化 session 状态

这一步用于减少容器重启时“最后几轮对话没落盘”的风险。

### 3.5 会话首轮 Markdown 注入（今昨摘要）

为兼顾“会话冷启动记忆”与 token 成本，DingTalk 首轮会话支持注入今天/昨天的 Markdown 摘要（仅文件层，不读向量库）：

- 只在会话首轮触发（避免每轮重复注入）。
- 仅注入 daily Markdown（main scope 读取 `memory/YYYY-MM-DD.md`；隔离 scope 读取 `memory/scopes/<scope>/YYYY-MM-DD.md`）。
- 采用硬性上限控制注入体积（按文件/总量裁剪），思路与 OpenClaw 的 `maxInjectedChars` 限额一致。
- 注入内容仅作背景，遇到历史细节问题仍应 `memory_search + memory_get` 取证。

### 3.6 每日 04:00 自动记忆归档（幂等）

DingTalk 启动时会自动确保存在“04:00 每日记忆归档” cron 任务（幂等，不重复创建）：

- 若不存在则创建。
- 若存在但配置漂移（调度表达式、提示词、开关状态）则自动修正。
- 若存在重复任务则清理重复项，仅保留一个。
- 归档内容与 compaction / memory flush 使用同一套“进行中工作态”固定结构，便于统一检索与复盘。

可通过 `dingtalk.cron.autoMemorySaveAt4=false` 关闭该自动保障。

---

## 4. 记忆检索与精读（memory_search / memory_get）

### 4.1 当前统一检索入口

`memory_search` 现在是统一召回：
- `memory_chunks`（长期/每日/transcript 索引）
- `session_events`（会话热日志）

然后按配置模式排序返回。
在回溯型问题（如“昨天/上次/之前/还记得吗”）下，会额外启用时间窗口召回策略，优先拉取对应时间段的会话事件。

### 4.2 触发条件（何时必须先 `memory_search`）

以下场景回答前应先检索，再作答：

- 问“之前做过什么、历史决策、偏好、待办、时间线、某人信息、某日期发生了什么”等历史事实问题。
- 用户出现回溯型问法，如“你还记得吗”“之前/上次/刚才”“今天/昨天”“我们是否聊过”等。

约束：

- 如果检索结果不足，必须明确说明“已检索但未找到足够信息”或“已检索但信息不足”。
- 禁止把猜测当成记忆事实。
- 需要精确引用（数字、日期、阈值、原话）时，应继续调用 `memory_get` 精读命中片段后再作答。
- 当用户明确要求“记住/保存”时，应调用 `memory_save` 写入对应记忆层（`daily` / `long-term`）。

### 4.3 检索模式

`agent.memory.retrieval.mode`：

- `keyword`：ILIKE 关键词匹配
- `fts`：PostgreSQL 全文检索（`websearch_to_tsquery + ts_rank_cd`）
- `vector`：向量检索（cosine）。默认对 `memory_chunks` 生效；回溯意图下会额外对 `session_events` 做语义召回并合并。
- `hybrid`：vector + fts 加权融合；同时融合 `session_events` 的 FTS/时间回溯候选，提升“昨天问了什么”这类查询命中率。

会话热日志可通过以下配置控制是否参与：
- `include_session_events`
- `session_events_max_results`
- `session_events_vector_async_enabled`（异步补齐 session event embedding）

### 4.4 降级路径

- PG 不可用：降级到文件系统逐行 keyword 检索
- pgvector/embedding 不可用：自动退回 FTS/keyword

### 4.5 `memory_get` 精读能力

`memory_get` 负责“按路径取证”，建议配合 `memory_search` 使用：

1. `memory_search` 找到候选路径（`path + line`）
2. `memory_get(path, from, lines)` 读取精确片段
3. 基于片段回答，并可附来源

支持读取：
- `MEMORY.md`
- `memory/**/*.md`（受 scope 隔离约束）
- `session_events/<sessionKey>/<conversationId>/event-<id>`（读取会话事件原文）

安全约束：
- 默认禁止跨 workspace 路径读取。
- 默认禁止跨 scope 读取（例如 main 读取 group scope，或 group 读取其他 group）。
- `lines` 默认 40，最大 300；超长内容会截断并返回 `truncated=true`。

### 4.6 触发矩阵（什么时候会调用）

`memory_search`：

1. 模型自主触发
- 系统提示词明确要求：回溯类问题优先检索。

2. DingTalk 通道强制触发（已实现）
- 当用户问题命中回溯意图（如“之前/上次/昨天/问过/聊过/历史”）时，会注入强约束提示，要求先 `memory_search` 再回答。
- 典型日志：`[DingTalk] Memory recall intent detected, enforce memory_search preflight`

3. 用户显式触发
- 用户直接要求“帮我用 memory_search 搜一下 ...”。

`memory_get`：

1. 模型在 `memory_search` 命中后，为了精确引用而触发
- 场景：需要原话、日期、阈值、配置项等精确证据。

2. 用户显式触发
- 用户直接给定 path 要求读取。

3. path 兼容
- 支持直接读取 `memory_search` 返回的 `path:line` 形式（会自动解析 line 作为 `from`）。
- 例如：`session_events/.../event-25:1`、`[session_events/.../event-25:1]`。

### 4.7 数据来源对照（`memory_search` vs `memory_get`）

`memory_search` 的数据来源：

- PG 可用时（`backend=pgsql`）：
  - `memory_chunks`：来自 `MEMORY.md` / `memory/**/*.md` 的切片索引（keyword/fts/vector/hybrid 主入口）
  - `session_events`：会话事件（session 热日志）
- PG 不可用时：
  - 回退到 workspace 下 Markdown 文件关键词检索

`memory_get` 的数据来源：

- path 以 `session_events/` 开头：
  - 读取 PG `session_events` 单条事件（按 `session_key + conversation_id + event_id`）
- 其他 path：
  - 读取 workspace 文件内容（`MEMORY.md`、`memory/**/*.md`，受 scope 安全约束）

一句话：
- `memory_search` = 找候选（path + line + score）
- `memory_get` = 按候选路径精读正文

---

## 5. 索引与同步策略

### 5.1 增量索引核心

- 启动：`syncIncremental(force=true)` 建立基线
- 保存：`memory_save` 后单文件强制索引
- transcript：append 后去抖同步（避免每条消息都强制重扫）
- 搜索前：按 `sync_on_search + sync_min_interval_ms` 触发条件同步
- 文件删除：全量同步时清理 PG 僵尸索引

### 5.2 向量相关

- 默认向量维度：`1536`
- 启动时尝试建 `vector` 扩展与 ivfflat 索引
- embedding 结果按 provider/model/hash 缓存
- 维度不匹配时会清理/跳过异常缓存
- `session_events` 的 embedding 采用异步回填（先写事件，后补向量），避免阻塞消息写入链路
- session event 向量检索走 PG 内 ANN 索引（ivfflat），embedding 异常时自动回退到 FTS/temporal
- 可配置 TTL 清理历史 session event（按 `created_at` 批量删除）

---

## 6. 会话隔离（Scope）

按 `agent.memory.session_isolation` 进行隔离：

- CLI：`main`
- DingTalk 私聊：默认 `direct_<senderId>`
- Web 直连：默认 `main`（团队共享记忆）；如需按用户隔离，可设 `web_direct_scope=direct`
- DingTalk 群聊：`group_<conversationId>`
- Web 多人共享会话：`group_web_<sessionId>`

`memory_save`、`memory_search`、`dingtalk_sessions`、`session_events` 都遵循同一 scope，避免串会话记忆。

---

## 7. 关键配置项

```jsonc
{
  "agent": {
    "memory": {
      "backend": "pgsql",
      "pgsql": {
        "enabled": true,
        "connection_string": "",
        "host": "127.0.0.1",
        "port": 5432,
        "user": "pomelobot",
        "password": "***",
        "database": "pomelobot",
        "ssl": false,
        "schema": "pomelobot_memory"
      },
      "retrieval": {
        "mode": "hybrid",
        "max_results": 8,
        "min_score": 0.1,
        "sync_on_search": true,
        "sync_min_interval_ms": 20000,
        "hybrid_vector_weight": 0.6,
        "hybrid_fts_weight": 0.4,
        "hybrid_candidate_multiplier": 2,
        "include_session_events": true,
        "session_events_max_results": 6,
        "session_events_vector_async_enabled": true,
        "session_events_vector_async_interval_ms": 5000,
        "session_events_vector_async_batch_size": 16,
        "session_events_ttl_days": 30,
        "session_events_ttl_cleanup_interval_ms": 600000
      },
      "embedding": {
        "enabled": true,
        "cache_enabled": true,
        "providers": [
          {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "api_key": "***",
            "timeout_ms": 15000
          }
        ]
      },
      "session_isolation": {
        "enabled": true,
        "direct_scope": "direct",
        "web_direct_scope": "main",
        "group_scope_prefix": "group_"
      },
      "transcript": {
        "enabled": true,
        "max_chars_per_entry": 3000
      }
    }
  }
}
```

---

## 8. 与 OpenClaw 的差异与优劣

### 8.1 机制差异

1. 记忆来源与权威层
- OpenClaw：文档强调 Memory 文件（如 `MEMORY.md`）与可扩展记忆源，检索基于索引，不是每次全量读 md。
- Pomelobot：也是“文件 + 索引”模式，但额外引入了 `dingtalk_sessions` / `session_events` 的会话态数据库层。

2. 会话记忆能力
- OpenClaw：文档提到有 experimental session memory 方向。
- Pomelobot：DingTalk 侧已经把 session events 纳入统一检索入口，实用性更强。

3. 工具面
- OpenClaw：文档强调 `memory_search` / `memory_get` / `memory_save` 组合。
- Pomelobot：已补齐 `memory_search` + `memory_get` + `memory_save` 三件套，并额外支持 session events 路径精读。

4. 同步策略
- OpenClaw：强调后台 watcher + debounce 的异步索引同步。
- Pomelobot：采用“启动基线 + 事件触发 + 检索前条件同步”的组合策略，更偏工程可控。

### 8.2 优劣对比

Pomelobot 的优势：
- 对 DingTalk / Web 场景友好：重启恢复与会话热日志能力完整，Web 还会补 transcript 和自动 flush。
- PG FTS + Vector + Hybrid + session events 统一召回，检索面更广。
- 故障降级路径明确（PG/向量不可用可回退）。

Pomelobot 的短板：
- 记忆治理（去重、冲突合并、TTL、质量评分）仍偏轻量。
- CLI 会话态仍是内存 checkpointer，重启后上下文连续性弱于 DingTalk。

OpenClaw 的优势（从文档设计看）：
- Memory/Compaction 概念体系完整，工具契约更标准化。
- 文件权威层 + 索引层边界清晰，便于长期治理。

OpenClaw 的潜在代价：
- 对接企业现有消息通道时，仍需额外补会话持久化与审计层。

---

## 9. 实践建议

1. 企业生产建议使用 `backend=pgsql + retrieval.mode=hybrid + include_session_events=true`。
2. 对高频会话，优先保障 PG 与 `vector` 扩展可用，减少降级触发。
3. 优先采用 “search -> get -> answer” 两阶段链路处理高风险问答（阈值、日期、决策、配置项）。

---

## 10. PG 查询性能评估与调优

### 10.1 当前实现的性能画像

你当前的 PG 检索链路总体是“可用且中等偏好”，但存在一个明显热点：

1. `memory_chunks` 检索（主记忆）
- FTS：`GIN(search_vector)` + `websearch_to_tsquery('simple', ...)` + `ts_rank_cd`
- Vector：`ivfflat (embedding vector_cosine_ops)`
- 这两条在数据量增长后仍可保持较稳定延迟，属于当前架构的性能强项。

2. `session_events` 检索（会话热日志）
- FTS/keyword 路径：有索引，性能通常可控。
- Vector 路径：当前是“先拉最近 N 条事件，再在应用层逐条算 embedding 相似度”。
- 这条路径在 cache miss、事件量大或 embedding provider 抖动时，会出现秒级抖动，是目前主要瓶颈。

3. 搜索前增量同步
- 当 `sync_on_search=true` 且命中 `sync_min_interval_ms` 窗口外，会先触发 `syncIncremental`，会把一次检索延迟拉高。
- 这是“新鲜度优先”的设计取舍，不是 bug。

### 10.2 这套 FTS 是什么

- 不是 SQLite FTS5 BM25。
- 当前是 PostgreSQL FTS（`tsvector/tsquery`）+ `ts_rank_cd` 排序。
- 对中文已通过查询侧分词增强（CJK n-gram token）做了兼容，但词法能力本质仍是 PG `simple` 字典。

### 10.3 建议的参数基线（SRE 场景）

建议先用下面这组参数，把“响应速度/召回质量”平衡到更稳态：

- `retrieval.mode=hybrid`
- `retrieval.max_results=6~8`
- `retrieval.min_score=0.12~0.18`
- `retrieval.hybrid_vector_weight=0.65`
- `retrieval.hybrid_fts_weight=0.35`
- `retrieval.include_session_events=true`
- `retrieval.session_events_max_results=4~6`
- `retrieval.sync_on_search=true`
- `retrieval.sync_min_interval_ms=30000~60000`

说明：
- 你现在最需要控的是 `session_events_max_results`，它会直接影响会话向量召回成本。
- 对“昨日/历史”问题优先让 FTS+时间窗先收敛，再让 vector 参与重排，整体更稳。

### 10.4 下一步高价值优化（按 ROI）

1. 高优先：给 `session_events` 增加持久化向量列 + ANN 索引
- 把会话事件 embedding 写入 PG（而不是查询时逐条现算）。
- 检索改为 SQL 侧 `ORDER BY embedding <=> query_vector`，可显著降低长尾延迟。

2. 中优先：为 SRE 结构化字段做“检索前过滤”
- 例如 `service/env/alert_id/severity` 放进 metadata，先 filter 再检索，减少无关候选。

3. 中优先：按时间衰减打分
- 对近期告警分析结果做轻度加权，提升“近期问题复盘”命中率。

4. 低优先：热点查询结果缓存
- 对高频问法（如“昨天我问过什么”）做短 TTL 缓存，进一步降低重复查询成本。
