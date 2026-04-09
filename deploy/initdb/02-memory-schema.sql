-- srebot memory bootstrap schema (PGSQL + FTS + pgvector)
-- This matches the runtime tables used by src/middleware/memory-runtime.ts

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS srebot_memory;

CREATE TABLE IF NOT EXISTS srebot_memory.memory_files (
    scope_key TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    source_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mtime_ms BIGINT NOT NULL,
    size_bytes BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope_key, rel_path)
);

CREATE TABLE IF NOT EXISTS srebot_memory.memory_chunks (
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

CREATE TABLE IF NOT EXISTS srebot_memory.embedding_cache (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    embedding vector(1536),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, model, content_hash)
);

CREATE INDEX IF NOT EXISTS memory_chunks_scope_idx
    ON srebot_memory.memory_chunks (scope_key);

CREATE INDEX IF NOT EXISTS memory_chunks_fts_idx
    ON srebot_memory.memory_chunks USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS memory_chunks_embedding_ivf_idx
    ON srebot_memory.memory_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS memory_files_scope_updated_idx
    ON srebot_memory.memory_files (scope_key, updated_at DESC);
