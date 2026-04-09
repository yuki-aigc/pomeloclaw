-- DingTalk session state persistence (survives service restarts)
-- Keep in sync with src/channels/dingtalk/session-store.ts

CREATE SCHEMA IF NOT EXISTS srebot_memory;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS srebot_memory.dingtalk_sessions (
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
    ON srebot_memory.dingtalk_sessions (scope_key);

CREATE INDEX IF NOT EXISTS dingtalk_sessions_updated_idx
    ON srebot_memory.dingtalk_sessions (last_updated DESC);

CREATE TABLE IF NOT EXISTS srebot_memory.dingtalk_session_events (
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
    ON srebot_memory.dingtalk_session_events (session_key, created_at DESC);

CREATE INDEX IF NOT EXISTS dingtalk_session_events_conversation_idx
    ON srebot_memory.dingtalk_session_events (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS dingtalk_session_events_created_at_idx
    ON srebot_memory.dingtalk_session_events (created_at DESC);

CREATE INDEX IF NOT EXISTS dingtalk_session_events_fts_idx
    ON srebot_memory.dingtalk_session_events
    USING GIN (to_tsvector('simple', COALESCE(content, '')));

CREATE INDEX IF NOT EXISTS dingtalk_session_events_embedding_ivf_idx
    ON srebot_memory.dingtalk_session_events
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
