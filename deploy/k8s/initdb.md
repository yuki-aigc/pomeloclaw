> 代码会自动建表，下面SQL仅适合权限不足时由DBA执行

# PostgreSQL 初始化数据库

StatefulSet Pod 名称为 `srebot-pgsql-0`，以下命令默认在 default namespace 下执行，按需加 `-n <namespace>`。

## 方式一：进容器用 psql 逐个执行

```bash
kubectl exec -it srebot-pgsql-0 -- psql -U pomelobot -d pomelobot
```

进入 psql 后按顺序粘贴执行：

```sql
-- 01-extensions.sql
CREATE EXTENSION IF NOT EXISTS vector;

-- 02-memory-schema.sql
CREATE SCHEMA IF NOT EXISTS pomelobot_memory;

CREATE TABLE IF NOT EXISTS pomelobot_memory.memory_files (
    scope_key TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    source_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mtime_ms BIGINT NOT NULL,
    size_bytes BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope_key, rel_path)
);

CREATE TABLE IF NOT EXISTS pomelobot_memory.memory_chunks (
    id BIGSERIAL PRIMARY KEY,
    scope_key TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    embedding_json TEXT,
    embedding vector(1536),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(content, ''))) STORED,
    UNIQUE (scope_key, rel_path, chunk_index)
);

CREATE TABLE IF NOT EXISTS pomelobot_memory.embedding_cache (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    embedding vector(1536),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, model, content_hash)
);

CREATE INDEX IF NOT EXISTS memory_chunks_scope_idx
    ON pomelobot_memory.memory_chunks (scope_key);
CREATE INDEX IF NOT EXISTS memory_chunks_fts_idx
    ON pomelobot_memory.memory_chunks USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS memory_chunks_embedding_ivf_idx
    ON pomelobot_memory.memory_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS memory_files_scope_updated_idx
    ON pomelobot_memory.memory_files (scope_key, updated_at DESC);

-- 03-dingtalk-session.sql
CREATE TABLE IF NOT EXISTS pomelobot_memory.dingtalk_sessions (
    session_key TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    compaction_count INTEGER NOT NULL DEFAULT 0,
    last_updated BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dingtalk_sessions_scope_idx
    ON pomelobot_memory.dingtalk_sessions (scope_key);
CREATE INDEX IF NOT EXISTS dingtalk_sessions_updated_idx
    ON pomelobot_memory.dingtalk_sessions (last_updated DESC);

CREATE TABLE IF NOT EXISTS pomelobot_memory.dingtalk_session_events (
    id BIGSERIAL PRIMARY KEY,
    session_key TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json JSONB,
    created_at BIGINT NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    embedding vector(1536),
    embedding_updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dingtalk_session_events_session_idx
    ON pomelobot_memory.dingtalk_session_events (session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS dingtalk_session_events_conversation_idx
    ON pomelobot_memory.dingtalk_session_events (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dingtalk_session_events_created_at_idx
    ON pomelobot_memory.dingtalk_session_events (created_at DESC);
CREATE INDEX IF NOT EXISTS dingtalk_session_events_fts_idx
    ON pomelobot_memory.dingtalk_session_events
    USING GIN (to_tsvector('simple', COALESCE(content, '')));
CREATE INDEX IF NOT EXISTS dingtalk_session_events_embedding_ivf_idx
    ON pomelobot_memory.dingtalk_session_events
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

## 方式二：本地文件通过 pipe 批量执行

先把 SQL 文件拷进容器再执行：

```bash
# 拷贝 initdb 目录到容器
kubectl cp deploy/initdb srebot-pgsql-0:/tmp/initdb

# 按顺序执行
kubectl exec -it srebot-pgsql-0 -- bash -c '
  for f in /tmp/initdb/*.sql; do
    echo ">>> executing $f"
    psql -U pomelobot -d pomelobot -f "$f"
  done
'
```

## 方式三：单条命令直接 pipe（不进容器）

```bash
cat deploy/initdb/01-extensions.sql deploy/initdb/02-memory-schema.sql deploy/initdb/03-dingtalk-session.sql | \
  kubectl exec -i srebot-pgsql-0 -- psql -U pomelobot -d pomelobot
```

## 验证

```bash
kubectl exec -it srebot-pgsql-0 -- psql -U pomelobot -d pomelobot -c "\dn"
# 应看到 pomelobot_memory schema

kubectl exec -it srebot-pgsql-0 -- psql -U pomelobot -d pomelobot -c "\dt pomelobot_memory.*"
# 应看到 memory_files, memory_chunks, embedding_cache, dingtalk_sessions, dingtalk_session_events
```
