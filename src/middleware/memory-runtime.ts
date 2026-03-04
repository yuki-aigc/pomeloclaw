import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import type {
    AgentMemoryConfig,
    AgentMemoryEmbeddingProviderConfig,
    AgentMemoryRetrievalMode,
    Config,
} from '../config.js';
import type { MemoryScope } from './memory-scope.js';
import { MemoryIndexerLayer } from './memory-runtime/indexer-layer.js';
import { MemoryRetrieverLayer } from './memory-runtime/retriever-layer.js';
import { MemoryStoreLayer } from './memory-runtime/store-layer.js';

const MAX_SNIPPET_CHARS = 220;
const DEFAULT_CHUNK_CHARS = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;
const DEFAULT_VECTOR_DIMENSIONS = 1536;
const TRANSCRIPT_SYNC_DEBOUNCE_MS = 1500;
const DEFAULT_MEMORY_GET_LINES = 40;
const MAX_MEMORY_GET_LINES = 300;
const MAX_MEMORY_GET_CHARS = 12000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TEMPORAL_RECENT_DAYS = 7;
const SESSION_VECTOR_TEXT_MAX_CHARS = 1600;
const SESSION_EVENTS_TTL_DELETE_BATCH = 2000;
const SESSION_EVENTS_TABLE = 'session_events';
const LEGACY_DINGTALK_SESSION_EVENTS_TABLE = 'dingtalk_session_events';

type MemorySourceType = 'daily' | 'long-term' | 'transcript' | 'session' | 'heartbeat';

interface FileMetaRow {
    scope_key: string;
    rel_path: string;
    content_hash: string;
    mtime_ms: number;
    size_bytes: number;
}

interface MemoryChunk {
    chunkIndex: number;
    startLine: number;
    endLine: number;
    text: string;
    hash: string;
}

export interface MemorySearchHit {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: MemorySourceType;
    strategy: AgentMemoryRetrievalMode | 'keyword';
}

export interface MemorySaveResult {
    path: string;
    scope: string;
}

export interface MemoryGetOptions {
    from?: number;
    lines?: number;
}

export interface MemoryGetResult {
    path: string;
    scope: string;
    source: MemorySourceType;
    fromLine: number;
    toLine: number;
    lineCount: number;
    text: string;
    truncated: boolean;
}

export interface MemorySessionEventInput {
    scope: MemoryScope;
    conversationId: string;
    role: 'user' | 'assistant' | 'summary';
    content: string;
    channel?: string;
    createdAt?: number;
    metadata?: Record<string, unknown>;
}

interface SearchRow {
    rel_path: string;
    chunk_index: number;
    start_line: number;
    end_line: number;
    content: string;
    source_type: MemorySourceType;
    score: number;
}

interface SessionEventRow {
    role: string;
    content: string;
}

interface SessionEventSearchRow {
    id: number | string;
    session_key: string;
    conversation_id: string;
    role: string;
    content: string;
    created_at: number | string;
}

function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
}

function tokenizeLexicalQuery(query: string): string[] {
    const text = query.trim();
    if (!text) {
        return [];
    }

    const tokens = new Set<string>();
    const addToken = (token: string) => {
        const normalized = token.trim().toLowerCase();
        if (!normalized) {
            return;
        }
        tokens.add(normalized);
    };

    addToken(text);

    const latinTokens = text.match(/[A-Za-z0-9_:-]{2,}/g) ?? [];
    for (const token of latinTokens) {
        addToken(token);
    }

    const cjkRuns = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
    for (const run of cjkRuns) {
        addToken(run);
        if (run.length <= 1) {
            continue;
        }

        for (let i = 0; i < run.length - 1; i += 1) {
            addToken(run.slice(i, i + 2));
        }
        for (let i = 0; i < run.length - 2; i += 1) {
            addToken(run.slice(i, i + 3));
        }
    }

    return Array.from(tokens)
        .sort((a, b) => b.length - a.length)
        .slice(0, 16);
}

function buildFtsQueryText(query: string): string {
    const tokens = tokenizeLexicalQuery(query)
        .map((token) => token.replace(/[&|!():*'"]/g, ' ').trim())
        .filter((token) => token.length > 0);
    if (tokens.length === 0) {
        return query.trim();
    }
    return tokens.join(' ');
}

function sortRowsByScore(rows: SearchRow[]): SearchRow[] {
    return rows
        .slice()
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            if (a.rel_path !== b.rel_path) {
                return a.rel_path.localeCompare(b.rel_path);
            }
            return a.chunk_index - b.chunk_index;
        });
}

interface EmbeddingProviderState {
    dimensionMismatch: Set<string>;
}

function quoteIdentifier(input: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input)) {
        throw new Error(`Invalid SQL identifier: ${input}`);
    }
    return `"${input}"`;
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function normalizeRelPath(workspacePath: string, absPath: string): string {
    return relative(workspacePath, absPath).replace(/\\/g, '/');
}

function inferScopeFromRelPath(relPath: string): string {
    const normalized = relPath.replace(/\\/g, '/');
    const match = normalized.match(/^memory\/scopes\/([^/]+)\//);
    return match?.[1] || 'main';
}

function inferSourceType(relPath: string): MemorySourceType {
    const normalized = relPath.replace(/\\/g, '/').toLowerCase();
    const name = basename(normalized);
    if (normalized.includes('/transcripts/')) {
        return 'transcript';
    }
    if (name === 'heartbeat.md') {
        return 'heartbeat';
    }
    if (name === 'memory.md' || name === 'long_term.md') {
        return 'long-term';
    }
    return 'daily';
}

function toVectorLiteral(embedding: number[]): string {
    const values = embedding
        .map((value) => Number.isFinite(value) ? String(value) : '0')
        .join(',');
    return `[${values}]`;
}

function isValidEmbedding(embedding: number[]): boolean {
    if (embedding.length !== DEFAULT_VECTOR_DIMENSIONS) {
        return false;
    }
    return embedding.every((value) => Number.isFinite(value));
}

function chunkMarkdown(content: string, maxChars = DEFAULT_CHUNK_CHARS, overlapChars = DEFAULT_CHUNK_OVERLAP): MemoryChunk[] {
    const lines = content.split('\n');
    if (lines.length === 0) {
        return [];
    }

    const chunks: MemoryChunk[] = [];
    let buffer: Array<{ line: string; lineNo: number }> = [];
    let bufferChars = 0;
    let chunkIndex = 0;

    const flush = () => {
        if (buffer.length === 0) return;
        const text = buffer.map((entry) => entry.line).join('\n');
        const first = buffer[0];
        const last = buffer[buffer.length - 1];
        if (!first || !last) return;
        chunks.push({
            chunkIndex,
            startLine: first.lineNo,
            endLine: last.lineNo,
            text,
            hash: sha256(text),
        });
        chunkIndex += 1;
    };

    const keepOverlap = () => {
        if (overlapChars <= 0 || buffer.length === 0) {
            buffer = [];
            bufferChars = 0;
            return;
        }
        let size = 0;
        const retained: Array<{ line: string; lineNo: number }> = [];
        for (let i = buffer.length - 1; i >= 0; i -= 1) {
            const row = buffer[i];
            if (!row) continue;
            size += row.line.length + 1;
            retained.unshift(row);
            if (size >= overlapChars) break;
        }
        buffer = retained;
        bufferChars = retained.reduce((acc, row) => acc + row.line.length + 1, 0);
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const segments = line.length === 0
            ? ['']
            : Array.from({ length: Math.ceil(line.length / maxChars) }, (_, idx) =>
                line.slice(idx * maxChars, (idx + 1) * maxChars)
            );

        for (const segment of segments) {
            const size = segment.length + 1;
            if (bufferChars + size > maxChars && buffer.length > 0) {
                flush();
                keepOverlap();
            }
            buffer.push({ line: segment, lineNo: i + 1 });
            bufferChars += size;
        }
    }

    flush();
    return chunks;
}

function summarizeSnippet(content: string): string {
    const compact = content.replace(/\s+/g, ' ').trim();
    if (compact.length <= MAX_SNIPPET_CHARS) {
        return compact;
    }
    return `${compact.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function normalizeScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function normalizeRankScore(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return value / (1 + value);
}

function mergeHybrid(
    vectorRows: SearchRow[],
    ftsRows: SearchRow[],
    vectorWeight: number,
    ftsWeight: number,
): MemorySearchHit[] {
    const merged = new Map<string, {
        row: SearchRow;
        vectorScore: number;
        ftsScore: number;
    }>();

    for (const row of vectorRows) {
        const key = `${row.rel_path}#${row.chunk_index}`;
        merged.set(key, {
            row,
            vectorScore: normalizeScore(row.score),
            ftsScore: 0,
        });
    }

    for (const row of ftsRows) {
        const key = `${row.rel_path}#${row.chunk_index}`;
        const current = merged.get(key);
        if (current) {
            current.ftsScore = normalizeRankScore(row.score);
            if (!current.row.content && row.content) {
                current.row = row;
            }
        } else {
            merged.set(key, {
                row,
                vectorScore: 0,
                ftsScore: normalizeRankScore(row.score),
            });
        }
    }

    return Array.from(merged.values())
        .map(({ row, vectorScore, ftsScore }) => ({
            path: row.rel_path,
            startLine: row.start_line,
            endLine: row.end_line,
            score: vectorWeight * vectorScore + ftsWeight * ftsScore,
            snippet: summarizeSnippet(row.content),
            source: row.source_type,
            strategy: 'hybrid' as const,
        }))
        .sort((a, b) => b.score - a.score);
}

async function walkMarkdownFiles(dir: string, files: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            await walkMarkdownFiles(abs, files);
            continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.md')) continue;
        files.push(abs);
    }
}

function buildPgPoolConfig(memoryConfig: AgentMemoryConfig): PoolConfig | null {
    const pg = memoryConfig.pgsql;
    if (pg.connection_string?.trim()) {
        return {
            connectionString: pg.connection_string.trim(),
            ssl: pg.ssl ? { rejectUnauthorized: false } : undefined,
        };
    }

    if (!pg.host || !pg.user || !pg.database) {
        return null;
    }

    return {
        host: pg.host,
        port: pg.port,
        user: pg.user,
        password: pg.password,
        database: pg.database,
        ssl: pg.ssl ? { rejectUnauthorized: false } : undefined,
    };
}

function resolveEmbeddingProviders(config: Config): AgentMemoryEmbeddingProviderConfig[] {
    const configured = config.agent.memory.embedding.providers
        .map((item) => ({ ...item }))
        .filter((item) => item.api_key?.trim());

    if (configured.length > 0) {
        return configured;
    }

    const openaiModel = config.llm.models.find((item) => item.provider === 'openai' && item.api_key?.trim());
    if (!openaiModel) {
        return [];
    }

    return [
        {
            provider: 'openai',
            base_url: openaiModel.base_url,
            model: 'text-embedding-3-small',
            api_key: openaiModel.api_key,
            timeout_ms: 15000,
        },
    ];
}

export class MemoryRuntime {
    private readonly workspacePath: string;
    private readonly config: Config;
    private readonly memoryConfig: AgentMemoryConfig;
    private readonly schemaName: string;
    private readonly schemaSql: string;
    private readonly filesTable: string;
    private readonly chunksTable: string;
    private readonly embeddingCacheTable: string;
    private readonly sessionEventsTable: string;
    private readonly legacySessionEventsTable: string;
    private readonly embeddingProviders: AgentMemoryEmbeddingProviderConfig[];
    private readonly indexerLayer: MemoryIndexerLayer;
    private readonly retrieverLayer: MemoryRetrieverLayer;
    private readonly storeLayer: MemoryStoreLayer;

    private pool: Pool | null = null;
    private pgReady = false;
    private vectorAvailable = false;
    private sessionEventsAvailable = false;
    private sessionEventVectorAvailable = false;
    private syncInFlight: Promise<void> | null = null;
    private lastSearchSyncAt = 0;
    private syncDebounceTimer: NodeJS.Timeout | null = null;
    private pendingSyncPaths = new Set<string>();
    private sessionEventEmbeddingBackfillTimer: NodeJS.Timeout | null = null;
    private sessionEventEmbeddingBackfillInFlight: Promise<void> | null = null;
    private sessionEventTtlCleanupTimer: NodeJS.Timeout | null = null;
    private sessionEventTtlCleanupInFlight: Promise<void> | null = null;
    private lastSessionEventTtlCleanupAt = 0;
    private readonly embeddingProviderState: EmbeddingProviderState = {
        dimensionMismatch: new Set<string>(),
    };

    private constructor(workspacePath: string, config: Config) {
        this.workspacePath = workspacePath;
        this.config = config;
        this.memoryConfig = config.agent.memory;
        this.schemaName = this.memoryConfig.pgsql.schema || 'pomelobot_memory';
        this.schemaSql = quoteIdentifier(this.schemaName);
        this.filesTable = `${this.schemaSql}.memory_files`;
        this.chunksTable = `${this.schemaSql}.memory_chunks`;
        this.embeddingCacheTable = `${this.schemaSql}.embedding_cache`;
        this.sessionEventsTable = `${this.schemaSql}.${quoteIdentifier(SESSION_EVENTS_TABLE)}`;
        this.legacySessionEventsTable = `${this.schemaSql}.${quoteIdentifier(LEGACY_DINGTALK_SESSION_EVENTS_TABLE)}`;
        this.embeddingProviders = resolveEmbeddingProviders(config);
        this.indexerLayer = new MemoryIndexerLayer({
            memoryConfig: this.memoryConfig,
            workspacePath: this.workspacePath,
            canUsePg: () => this.canUsePg(),
            buildPgPoolConfig: () => buildPgPoolConfig(this.memoryConfig),
            getPool: () => this.pool,
            setPool: (pool) => {
                this.pool = pool;
            },
            ensurePgSchema: () => this.ensurePgSchema(),
            startBackgroundWorkers: () => this.startBackgroundWorkers(),
            stopBackgroundWorkers: () => this.stopBackgroundWorkers(),
            getSessionEventEmbeddingBackfillInFlight: () => this.sessionEventEmbeddingBackfillInFlight,
            getSessionEventTtlCleanupInFlight: () => this.sessionEventTtlCleanupInFlight,
            getSyncDebounceTimer: () => this.syncDebounceTimer,
            setSyncDebounceTimer: (timer) => {
                this.syncDebounceTimer = timer;
            },
            setPgReady: (value) => {
                this.pgReady = value;
            },
            setVectorAvailable: (value) => {
                this.vectorAvailable = value;
            },
            setSessionEventsAvailable: (value) => {
                this.sessionEventsAvailable = value;
            },
            setSessionEventVectorAvailable: (value) => {
                this.sessionEventVectorAvailable = value;
            },
            getSyncInFlight: () => this.syncInFlight,
            setSyncInFlight: (value) => {
                this.syncInFlight = value;
            },
            runIncrementalSync: (options) => this.runIncrementalSync(options),
            pendingSyncPaths: this.pendingSyncPaths,
            syncIncrementalRef: (options) => this.syncIncremental(options),
            transcriptSyncDebounceMs: TRANSCRIPT_SYNC_DEBOUNCE_MS,
        });
        this.retrieverLayer = new MemoryRetrieverLayer({
            memoryConfig: this.memoryConfig,
            canUsePg: () => this.canUsePg(),
            maybeSyncBeforeSearch: () => this.maybeSyncBeforeSearch(),
            searchFromFiles: (query, scope) => this.searchFromFiles(query, scope),
            searchPgKeywordUnified: (query, scopeKey, limit) => this.searchPgKeywordUnified(query, scopeKey, limit),
            searchPgFtsUnified: (query, scopeKey, limit) => this.searchPgFtsUnified(query, scopeKey, limit),
            searchPgVector: (query, scopeKey, limit) => this.searchPgVector(query, scopeKey, limit),
            searchPgSessionEventsFts: (query, scopeKey, limit) => this.searchPgSessionEventsFts(query, scopeKey, limit),
            searchPgSessionEventsVector: (query, scopeKey, limit) => this.searchPgSessionEventsVector(query, scopeKey, limit),
            searchPgSessionEventsTemporal: (query, scopeKey, limit) => this.searchPgSessionEventsTemporal(query, scopeKey, limit),
            mergeRows: (rows, limit) => this.mergeRows(rows, limit),
            rowToHit: (row, strategy) => this.rowToHit(row, strategy),
            mergeHybrid: (vectorRows, ftsRows, vectorWeight, ftsWeight) =>
                mergeHybrid(vectorRows, ftsRows, vectorWeight, ftsWeight),
            readSessionEvent: (path, range, scope) => this.readSessionEvent(path, range, scope),
            readMemoryFile: (path, range, scope) => this.readMemoryFile(path, range, scope),
            maxMemoryGetLines: MAX_MEMORY_GET_LINES,
            maxMemoryGetChars: MAX_MEMORY_GET_CHARS,
            defaultMemoryGetLines: DEFAULT_MEMORY_GET_LINES,
        });
        this.storeLayer = new MemoryStoreLayer({
            workspacePath: this.workspacePath,
            memoryConfig: this.memoryConfig,
            canUsePg: () => this.canUsePg(),
            syncIncremental: (options) => this.syncIncremental(options),
            schedulePathSync: (paths) => this.schedulePathSync(paths),
        });
    }

    static async create(workspacePath: string, config: Config): Promise<MemoryRuntime> {
        const runtime = new MemoryRuntime(workspacePath, config);
        await runtime.initialize();
        return runtime;
    }

    private async initialize(): Promise<void> {
        await this.indexerLayer.initialize();
    }

    canUsePg(): boolean {
        return this.pgReady && this.pool !== null;
    }

    async close(): Promise<void> {
        await this.indexerLayer.close();
    }

    private startBackgroundWorkers(): void {
        this.stopBackgroundWorkers();
        if (!this.canUsePg()) {
            return;
        }

        const retrieval = this.memoryConfig.retrieval;
        if (
            retrieval.session_events_vector_async_enabled
            && this.memoryConfig.embedding.enabled
            && this.sessionEventsAvailable
            && this.sessionEventVectorAvailable
        ) {
            const intervalMs = Math.max(1000, retrieval.session_events_vector_async_interval_ms);
            this.sessionEventEmbeddingBackfillTimer = setInterval(() => {
                void this.backfillSessionEventEmbeddings();
            }, intervalMs);
            void this.backfillSessionEventEmbeddings();
        }

        if (retrieval.session_events_ttl_days > 0 && this.sessionEventsAvailable) {
            const intervalMs = Math.max(60_000, retrieval.session_events_ttl_cleanup_interval_ms);
            this.sessionEventTtlCleanupTimer = setInterval(() => {
                void this.cleanupExpiredSessionEvents();
            }, intervalMs);
            void this.cleanupExpiredSessionEvents();
        }
    }

    private stopBackgroundWorkers(): void {
        this.stopSessionEventEmbeddingWorker();
        if (this.sessionEventTtlCleanupTimer) {
            clearInterval(this.sessionEventTtlCleanupTimer);
            this.sessionEventTtlCleanupTimer = null;
        }
    }

    private stopSessionEventEmbeddingWorker(): void {
        if (this.sessionEventEmbeddingBackfillTimer) {
            clearInterval(this.sessionEventEmbeddingBackfillTimer);
            this.sessionEventEmbeddingBackfillTimer = null;
        }
    }

    private async ensurePgSchema(): Promise<void> {
        if (!this.pool) return;

        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.filesTable} (
                scope_key TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                source_type TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                mtime_ms BIGINT NOT NULL,
                size_bytes BIGINT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (scope_key, rel_path)
            )`
        );

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.chunksTable} (
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
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED,
                UNIQUE (scope_key, rel_path, chunk_index)
            )`
        );

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.embeddingCacheTable} (
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (provider, model, content_hash)
            )`
        );

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.sessionEventsTable} (
                id BIGSERIAL PRIMARY KEY,
                session_key TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                channel TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata_json JSONB,
                created_at BIGINT NOT NULL,
                inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`
        );
        await this.pool.query(
            `ALTER TABLE ${this.sessionEventsTable}
             ADD COLUMN IF NOT EXISTS channel TEXT`
        );
        await this.pool.query(
            `ALTER TABLE ${this.sessionEventsTable}
             ADD COLUMN IF NOT EXISTS metadata_json JSONB`
        );
        await this.pool.query(
            `ALTER TABLE ${this.sessionEventsTable}
             ADD COLUMN IF NOT EXISTS inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
        );
        await this.migrateLegacySessionEventsTable();

        await this.pool.query(`CREATE INDEX IF NOT EXISTS memory_chunks_scope_idx ON ${this.chunksTable} (scope_key)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS memory_chunks_fts_idx ON ${this.chunksTable} USING GIN (search_vector)`);
        try {
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS session_events_session_idx
                 ON ${this.sessionEventsTable} (session_key, created_at DESC)`
            );
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS session_events_conversation_idx
                 ON ${this.sessionEventsTable} (conversation_id, created_at DESC)`
            );
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS session_events_created_at_idx
                 ON ${this.sessionEventsTable} (created_at DESC)`
            );
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS session_events_fts_idx
                 ON ${this.sessionEventsTable}
                 USING GIN (to_tsvector('simple', coalesce(content, '')))`
            );
            this.sessionEventsAvailable = true;
        } catch (error) {
            this.sessionEventsAvailable = false;
            console.warn('[Memory] session events index unavailable, session retrieval disabled:', error instanceof Error ? error.message : String(error));
        }

        if (!this.memoryConfig.embedding.enabled) {
            this.vectorAvailable = false;
            this.sessionEventVectorAvailable = false;
            return;
        }

        try {
            await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
            await this.pool.query(`ALTER TABLE ${this.chunksTable} ADD COLUMN IF NOT EXISTS embedding vector(${DEFAULT_VECTOR_DIMENSIONS})`);
            await this.pool.query(`ALTER TABLE ${this.embeddingCacheTable} ADD COLUMN IF NOT EXISTS embedding vector(${DEFAULT_VECTOR_DIMENSIONS})`);
            await this.pool.query(`ALTER TABLE ${this.sessionEventsTable} ADD COLUMN IF NOT EXISTS embedding vector(${DEFAULT_VECTOR_DIMENSIONS})`);
            await this.pool.query(`ALTER TABLE ${this.sessionEventsTable} ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ`);
            await this.pool.query(
                `UPDATE ${this.chunksTable}
                 SET embedding = NULL
                 WHERE embedding IS NOT NULL
                   AND vector_dims(embedding) <> ${DEFAULT_VECTOR_DIMENSIONS}`
            );
            await this.pool.query(
                `UPDATE ${this.embeddingCacheTable}
                 SET embedding = NULL
                 WHERE embedding IS NOT NULL
                   AND vector_dims(embedding) <> ${DEFAULT_VECTOR_DIMENSIONS}`
            );
            await this.pool.query(
                `UPDATE ${this.sessionEventsTable}
                 SET embedding = NULL
                 WHERE embedding IS NOT NULL
                   AND vector_dims(embedding) <> ${DEFAULT_VECTOR_DIMENSIONS}`
            );
            await this.pool.query(
                `ALTER TABLE ${this.chunksTable}
                 ALTER COLUMN embedding TYPE vector(${DEFAULT_VECTOR_DIMENSIONS})
                 USING CASE
                    WHEN embedding IS NULL THEN NULL
                    WHEN vector_dims(embedding) = ${DEFAULT_VECTOR_DIMENSIONS} THEN embedding::vector(${DEFAULT_VECTOR_DIMENSIONS})
                    ELSE NULL
                 END`
            );
            await this.pool.query(
                `ALTER TABLE ${this.embeddingCacheTable}
                 ALTER COLUMN embedding TYPE vector(${DEFAULT_VECTOR_DIMENSIONS})
                 USING CASE
                    WHEN embedding IS NULL THEN NULL
                    WHEN vector_dims(embedding) = ${DEFAULT_VECTOR_DIMENSIONS} THEN embedding::vector(${DEFAULT_VECTOR_DIMENSIONS})
                    ELSE NULL
                 END`
            );
            await this.pool.query(
                `ALTER TABLE ${this.sessionEventsTable}
                 ALTER COLUMN embedding TYPE vector(${DEFAULT_VECTOR_DIMENSIONS})
                 USING CASE
                    WHEN embedding IS NULL THEN NULL
                    WHEN vector_dims(embedding) = ${DEFAULT_VECTOR_DIMENSIONS} THEN embedding::vector(${DEFAULT_VECTOR_DIMENSIONS})
                    ELSE NULL
                 END`
            );
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS memory_chunks_embedding_ivf_idx
                 ON ${this.chunksTable} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
            );
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS session_events_embedding_ivf_idx
                 ON ${this.sessionEventsTable} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
            );
            this.vectorAvailable = true;
            this.sessionEventVectorAvailable = true;
        } catch (error) {
            this.vectorAvailable = false;
            this.sessionEventVectorAvailable = false;
            console.warn('[Memory] pgvector unavailable, vector retrieval disabled:', error instanceof Error ? error.message : String(error));
        }
    }

    async syncIncremental(options?: { force?: boolean; onlyPaths?: string[] }): Promise<void> {
        return this.indexerLayer.syncIncremental(options);
    }

    private schedulePathSync(paths: string[]): void {
        this.indexerLayer.schedulePathSync(paths);
    }

    private async flushPendingSync(): Promise<void> {
        await this.indexerLayer.flushPendingSync();
    }

    private shouldRunSessionEventEmbeddingBackfill(): boolean {
        return this.canUsePg()
            && this.memoryConfig.embedding.enabled
            && this.embeddingProviders.length > 0
            && this.memoryConfig.retrieval.session_events_vector_async_enabled
            && this.sessionEventsAvailable
            && this.sessionEventVectorAvailable;
    }

    private async backfillSessionEventEmbeddings(): Promise<void> {
        if (this.sessionEventEmbeddingBackfillInFlight) {
            return this.sessionEventEmbeddingBackfillInFlight;
        }
        if (!this.shouldRunSessionEventEmbeddingBackfill() || !this.pool) {
            return;
        }

        this.sessionEventEmbeddingBackfillInFlight = (async () => {
            const batchSize = Math.max(1, this.memoryConfig.retrieval.session_events_vector_async_batch_size);
            try {
                const result = await this.pool!.query<SessionEventSearchRow>(
                    `SELECT id, role, content
                     FROM ${this.sessionEventsTable}
                     WHERE embedding IS NULL
                       AND length(trim(content)) > 0
                     ORDER BY created_at ASC
                     LIMIT $1`,
                    [batchSize]
                );
                if (result.rows.length === 0) {
                    return;
                }

                let updatedCount = 0;
                for (const row of result.rows) {
                    const baseText = `[${row.role}] ${row.content}`;
                    if (!baseText.trim()) {
                        continue;
                    }
                    const embedText = baseText.length > SESSION_VECTOR_TEXT_MAX_CHARS
                        ? `${baseText.slice(0, SESSION_VECTOR_TEXT_MAX_CHARS - 1)}…`
                        : baseText;
                    const embedHash = sha256(`session-event:${row.id}:${embedText}`);
                    const embedding = await this.getOrCreateEmbedding(embedText, embedHash);
                    if (!embedding || embedding.length === 0) {
                        continue;
                    }

                    await this.pool!.query(
                        `UPDATE ${this.sessionEventsTable}
                         SET embedding = $2::vector,
                             embedding_updated_at = NOW()
                         WHERE id = $1
                           AND embedding IS NULL`,
                        [row.id, toVectorLiteral(embedding)]
                    );
                    updatedCount += 1;
                }

                if (updatedCount > 0) {
                    console.info(`[Memory] session event embedding backfill updated=${updatedCount}`);
                }
            } catch (error) {
                const code = typeof error === 'object' && error !== null && 'code' in error
                    ? String((error as { code?: unknown }).code ?? '')
                    : '';
                if (code === '42P01' || code === '42703') {
                    this.sessionEventsAvailable = false;
                    this.sessionEventVectorAvailable = false;
                    this.stopBackgroundWorkers();
                }
                console.warn('[Memory] session event embedding backfill failed:', error instanceof Error ? error.message : String(error));
            }
        })().finally(() => {
            this.sessionEventEmbeddingBackfillInFlight = null;
        });

        return this.sessionEventEmbeddingBackfillInFlight;
    }

    private shouldRunSessionEventTtlCleanup(): boolean {
        return this.canUsePg()
            && this.sessionEventsAvailable
            && this.memoryConfig.retrieval.session_events_ttl_days > 0;
    }

    private async cleanupExpiredSessionEvents(): Promise<void> {
        if (this.sessionEventTtlCleanupInFlight) {
            return this.sessionEventTtlCleanupInFlight;
        }
        if (!this.shouldRunSessionEventTtlCleanup() || !this.pool) {
            return;
        }

        const cleanupInterval = Math.max(60_000, this.memoryConfig.retrieval.session_events_ttl_cleanup_interval_ms);
        const now = Date.now();
        if (now - this.lastSessionEventTtlCleanupAt < cleanupInterval) {
            return;
        }
        this.lastSessionEventTtlCleanupAt = now;

        this.sessionEventTtlCleanupInFlight = (async () => {
            const ttlDays = this.memoryConfig.retrieval.session_events_ttl_days;
            const cutoffMs = now - (ttlDays * ONE_DAY_MS);
            try {
                const result = await this.pool!.query(
                    `DELETE FROM ${this.sessionEventsTable}
                     WHERE id IN (
                         SELECT id
                         FROM ${this.sessionEventsTable}
                         WHERE created_at < $1
                         ORDER BY created_at ASC
                         LIMIT $2
                     )`,
                    [cutoffMs, SESSION_EVENTS_TTL_DELETE_BATCH]
                );
                const deleted = result.rowCount ?? 0;
                if (deleted > 0) {
                    console.info(`[Memory] session event ttl cleanup deleted=${deleted} cutoffMs=${cutoffMs}`);
                }
            } catch (error) {
                const code = typeof error === 'object' && error !== null && 'code' in error
                    ? String((error as { code?: unknown }).code ?? '')
                    : '';
                if (code === '42P01' || code === '42703') {
                    this.sessionEventsAvailable = false;
                    this.sessionEventVectorAvailable = false;
                    this.stopBackgroundWorkers();
                }
                console.warn('[Memory] session event ttl cleanup failed:', error instanceof Error ? error.message : String(error));
            }
        })().finally(() => {
            this.sessionEventTtlCleanupInFlight = null;
        });

        return this.sessionEventTtlCleanupInFlight;
    }

    private async migrateLegacySessionEventsTable(): Promise<void> {
        if (!this.pool || this.legacySessionEventsTable === this.sessionEventsTable) {
            return;
        }

        const legacyExists = await this.pool.query<{ exists: boolean }>(
            `SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = $1
                  AND table_name = $2
            ) AS exists`,
            [this.schemaName, LEGACY_DINGTALK_SESSION_EVENTS_TABLE]
        );
        if (!legacyExists.rows[0]?.exists) {
            return;
        }

        await this.pool.query(
            `ALTER TABLE ${this.legacySessionEventsTable}
             ADD COLUMN IF NOT EXISTS channel TEXT`
        ).catch(() => undefined);

        await this.pool.query(
            `INSERT INTO ${this.sessionEventsTable} (
                session_key,
                conversation_id,
                channel,
                role,
                content,
                metadata_json,
                created_at,
                inserted_at
            )
            SELECT
                legacy.session_key,
                legacy.conversation_id,
                COALESCE(legacy.channel, 'dingtalk'),
                legacy.role,
                legacy.content,
                legacy.metadata_json,
                legacy.created_at,
                COALESCE(legacy.inserted_at, NOW())
            FROM ${this.legacySessionEventsTable} AS legacy
            LEFT JOIN ${this.sessionEventsTable} AS current
              ON current.session_key = legacy.session_key
             AND current.conversation_id = legacy.conversation_id
             AND current.role = legacy.role
             AND current.content = legacy.content
             AND current.created_at = legacy.created_at
            WHERE current.id IS NULL`
        ).catch((error) => {
            console.warn('[Memory] legacy session event migration skipped:', error instanceof Error ? error.message : String(error));
        });
    }

    private handleSessionEventStorageError(error: unknown): void {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : '';
        if (code === '42P01' || code === '42703') {
            this.sessionEventsAvailable = false;
            this.sessionEventVectorAvailable = false;
            this.stopBackgroundWorkers();
        }
    }

    private async runIncrementalSync(options?: { force?: boolean; onlyPaths?: string[] }): Promise<void> {
        if (!this.pool) return;

        const onlyPaths = options?.onlyPaths
            ?.map((item) => resolve(item))
            .filter((item) => item.startsWith(this.workspacePath));

        const files = onlyPaths && onlyPaths.length > 0
            ? onlyPaths
            : await this.listIndexableFiles();

        const existing = await this.readIndexedFileMeta();
        const seen = new Set<string>();

        for (const absPath of files) {
            let fileStat;
            try {
                fileStat = await stat(absPath);
            } catch {
                continue;
            }
            if (!fileStat.isFile()) {
                continue;
            }

            const relPath = normalizeRelPath(this.workspacePath, absPath);
            const scopeKey = inferScopeFromRelPath(relPath);
            const sourceType = inferSourceType(relPath);
            const key = `${scopeKey}\0${relPath}`;
            seen.add(key);

            const prev = existing.get(key);
            const mtimeMs = Math.round(fileStat.mtimeMs);
            const sizeBytes = Math.round(fileStat.size);
            const unchanged = !options?.force
                && prev
                && prev.mtime_ms === mtimeMs
                && prev.size_bytes === sizeBytes;
            if (unchanged) {
                continue;
            }

            await this.indexOneFile({
                absPath,
                relPath,
                scopeKey,
                sourceType,
                mtimeMs,
                sizeBytes,
                previousHash: prev?.content_hash,
            });
        }

        if (onlyPaths && onlyPaths.length > 0) {
            return;
        }

        for (const [key, row] of existing.entries()) {
            if (seen.has(key)) continue;
            await this.deleteIndexedFile(row.scope_key, row.rel_path);
        }
    }

    private async listIndexableFiles(): Promise<string[]> {
        const files: string[] = [];
        const longTermMain = join(this.workspacePath, 'MEMORY.md');
        const heartbeatMain = join(this.workspacePath, 'HEARTBEAT.md');
        const memoryDir = join(this.workspacePath, 'memory');

        if (existsSync(longTermMain)) {
            files.push(longTermMain);
        }
        if (existsSync(heartbeatMain)) {
            files.push(heartbeatMain);
        }

        if (existsSync(memoryDir)) {
            await walkMarkdownFiles(memoryDir, files);
        }

        return files;
    }

    private async readIndexedFileMeta(): Promise<Map<string, FileMetaRow>> {
        const map = new Map<string, FileMetaRow>();
        if (!this.pool) return map;

        const result = await this.pool.query<FileMetaRow>(
            `SELECT scope_key, rel_path, content_hash, mtime_ms, size_bytes FROM ${this.filesTable}`
        );

        for (const row of result.rows) {
            map.set(`${row.scope_key}\0${row.rel_path}`, row);
        }
        return map;
    }

    private async deleteIndexedFile(scopeKey: string, relPath: string): Promise<void> {
        if (!this.pool) return;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`DELETE FROM ${this.chunksTable} WHERE scope_key = $1 AND rel_path = $2`, [scopeKey, relPath]);
            await client.query(`DELETE FROM ${this.filesTable} WHERE scope_key = $1 AND rel_path = $2`, [scopeKey, relPath]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async indexOneFile(params: {
        absPath: string;
        relPath: string;
        scopeKey: string;
        sourceType: MemorySourceType;
        mtimeMs: number;
        sizeBytes: number;
        previousHash?: string;
    }): Promise<void> {
        if (!this.pool) return;

        const content = await readFile(params.absPath, 'utf-8');
        const contentHash = sha256(content);

        if (params.previousHash && params.previousHash === contentHash) {
            await this.pool.query(
                `INSERT INTO ${this.filesTable} (scope_key, rel_path, source_type, content_hash, mtime_ms, size_bytes, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 ON CONFLICT (scope_key, rel_path)
                 DO UPDATE SET
                   source_type = EXCLUDED.source_type,
                   content_hash = EXCLUDED.content_hash,
                   mtime_ms = EXCLUDED.mtime_ms,
                   size_bytes = EXCLUDED.size_bytes,
                   updated_at = NOW()`,
                [
                    params.scopeKey,
                    params.relPath,
                    params.sourceType,
                    contentHash,
                    params.mtimeMs,
                    params.sizeBytes,
                ]
            );
            return;
        }

        const chunks = chunkMarkdown(content);
        const embeddings = (this.memoryConfig.embedding.enabled && (this.memoryConfig.retrieval.mode === 'vector' || this.memoryConfig.retrieval.mode === 'hybrid'))
            ? await this.embedChunks(chunks.map((chunk) => ({ hash: chunk.hash, text: chunk.text })))
            : new Map<string, number[]>();

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `INSERT INTO ${this.filesTable} (scope_key, rel_path, source_type, content_hash, mtime_ms, size_bytes, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 ON CONFLICT (scope_key, rel_path)
                 DO UPDATE SET
                   source_type = EXCLUDED.source_type,
                   content_hash = EXCLUDED.content_hash,
                   mtime_ms = EXCLUDED.mtime_ms,
                   size_bytes = EXCLUDED.size_bytes,
                   updated_at = NOW()`,
                [
                    params.scopeKey,
                    params.relPath,
                    params.sourceType,
                    contentHash,
                    params.mtimeMs,
                    params.sizeBytes,
                ]
            );

            await client.query(`DELETE FROM ${this.chunksTable} WHERE scope_key = $1 AND rel_path = $2`, [
                params.scopeKey,
                params.relPath,
            ]);

            for (const chunk of chunks) {
                const embedding = embeddings.get(chunk.hash);
                const embeddingJson = embedding ? JSON.stringify(embedding) : null;
                if (this.vectorAvailable) {
                    await client.query(
                        `INSERT INTO ${this.chunksTable}
                         (scope_key, rel_path, chunk_index, source_type, start_line, end_line, content, chunk_hash, embedding_json, embedding, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, NOW())`,
                        [
                            params.scopeKey,
                            params.relPath,
                            chunk.chunkIndex,
                            params.sourceType,
                            chunk.startLine,
                            chunk.endLine,
                            chunk.text,
                            chunk.hash,
                            embeddingJson,
                            embedding ? toVectorLiteral(embedding) : null,
                        ]
                    );
                } else {
                    await client.query(
                        `INSERT INTO ${this.chunksTable}
                         (scope_key, rel_path, chunk_index, source_type, start_line, end_line, content, chunk_hash, embedding_json, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
                        [
                            params.scopeKey,
                            params.relPath,
                            chunk.chunkIndex,
                            params.sourceType,
                            chunk.startLine,
                            chunk.endLine,
                            chunk.text,
                            chunk.hash,
                            embeddingJson,
                        ]
                    );
                }
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async embedChunks(entries: Array<{ hash: string; text: string }>): Promise<Map<string, number[]>> {
        const result = new Map<string, number[]>();
        for (const entry of entries) {
            if (!entry.text.trim()) {
                continue;
            }
            const embedding = await this.getOrCreateEmbedding(entry.text, entry.hash);
            if (embedding && embedding.length > 0) {
                result.set(entry.hash, embedding);
            }
        }
        return result;
    }

    private async getOrCreateEmbedding(text: string, contentHash: string): Promise<number[] | null> {
        if (!this.pool || this.embeddingProviders.length === 0) {
            return null;
        }
        if (!text.trim()) {
            return null;
        }

        for (const provider of this.embeddingProviders) {
            const providerKey = `${provider.provider}:${provider.model}`;
            if (this.embeddingProviderState.dimensionMismatch.has(providerKey)) {
                continue;
            }

            if (this.memoryConfig.embedding.cache_enabled) {
                const cached = await this.pool.query<{ embedding_json: string }>(
                    `SELECT embedding_json
                     FROM ${this.embeddingCacheTable}
                     WHERE provider = $1 AND model = $2 AND content_hash = $3
                     LIMIT 1`,
                    [provider.provider, provider.model, contentHash]
                );

                if (cached.rows[0]?.embedding_json) {
                    try {
                        const parsed = JSON.parse(cached.rows[0].embedding_json) as unknown;
                        if (Array.isArray(parsed)) {
                            const vector = parsed.map((value) => Number(value));
                            if (isValidEmbedding(vector)) {
                                return vector;
                            }
                            console.warn(
                                `[Memory] ignore cached embedding with invalid dimensions (${vector.length}), expected ${DEFAULT_VECTOR_DIMENSIONS}`
                            );
                        } else {
                            console.warn(
                                `[Memory] ignore cached embedding with invalid dimensions (unknown), expected ${DEFAULT_VECTOR_DIMENSIONS}`
                            );
                        }
                        await this.pool.query(
                            `DELETE FROM ${this.embeddingCacheTable}
                             WHERE provider = $1 AND model = $2 AND content_hash = $3`,
                            [provider.provider, provider.model, contentHash]
                        ).catch(() => undefined);
                    } catch {
                        // ignore invalid cache and fallback to provider request
                    }
                }
            }

            try {
                const embedding = await this.requestEmbedding(text, provider);
                if (!isValidEmbedding(embedding)) {
                    console.warn(
                        `[Memory] embedding dimensions mismatch for ${provider.provider}/${provider.model}: got ${embedding.length}, expected ${DEFAULT_VECTOR_DIMENSIONS}`
                    );
                    this.embeddingProviderState.dimensionMismatch.add(providerKey);
                    continue;
                }

                await this.pool.query(
                    `INSERT INTO ${this.embeddingCacheTable}
                     (provider, model, content_hash, embedding_json, embedding, updated_at)
                     VALUES ($1, $2, $3, $4, $5::vector, NOW())
                     ON CONFLICT (provider, model, content_hash)
                     DO UPDATE SET
                       embedding_json = EXCLUDED.embedding_json,
                       embedding = EXCLUDED.embedding,
                       updated_at = NOW()`,
                    [
                        provider.provider,
                        provider.model,
                        contentHash,
                        JSON.stringify(embedding),
                        this.vectorAvailable ? toVectorLiteral(embedding) : null,
                    ]
                ).catch(async () => {
                    await this.pool?.query(
                        `INSERT INTO ${this.embeddingCacheTable}
                         (provider, model, content_hash, embedding_json, updated_at)
                         VALUES ($1, $2, $3, $4, NOW())
                         ON CONFLICT (provider, model, content_hash)
                         DO UPDATE SET
                           embedding_json = EXCLUDED.embedding_json,
                           updated_at = NOW()`,
                        [provider.provider, provider.model, contentHash, JSON.stringify(embedding)]
                    );
                });

                return embedding;
            } catch (error) {
                console.warn('[Memory] embedding provider failed, try fallback:', error instanceof Error ? error.message : String(error));
            }
        }

        return null;
    }

    private async requestEmbedding(
        text: string,
        provider: AgentMemoryEmbeddingProviderConfig,
    ): Promise<number[]> {
        const base = provider.base_url.replace(/\/$/, '');
        const endpoint = `${base}/embeddings`;
        const timeoutMs = provider.timeout_ms > 0 ? provider.timeout_ms : 15000;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const requestJson = async (body: unknown) => {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${provider.api_key}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const rawText = await response.text();
            let parsedJson: unknown = null;
            try {
                parsedJson = rawText ? JSON.parse(rawText) : null;
            } catch {
                parsedJson = null;
            }
            return { response, rawText, parsedJson };
        };

        const extractVector = (payload: unknown): number[] | null => {
            if (!payload || typeof payload !== 'object') {
                return null;
            }
            const record = payload as Record<string, unknown>;

            const openaiVector = (record.data as Array<{ embedding?: unknown }> | undefined)?.[0]?.embedding;
            if (Array.isArray(openaiVector) && openaiVector.length > 0) {
                return openaiVector.map((value) => Number(value));
            }

            const output = record.output as Record<string, unknown> | undefined;
            const outputEmbeddings = output?.embeddings as Array<{ embedding?: unknown }> | undefined;
            const dashscopeVector = outputEmbeddings?.[0]?.embedding;
            if (Array.isArray(dashscopeVector) && dashscopeVector.length > 0) {
                return dashscopeVector.map((value) => Number(value));
            }

            return null;
        };

        try {
            const primary = await requestJson({
                model: provider.model,
                input: [text],
                dimensions: DEFAULT_VECTOR_DIMENSIONS,
                encoding_format: 'float',
            });

            if (primary.response.ok) {
                const vector = extractVector(primary.parsedJson);
                if (vector && vector.length > 0) {
                    return vector;
                }
                throw new Error('embedding response missing vector data');
            }

            const primaryErrorSnippet = primary.rawText.slice(0, 300);
            const shouldTryDashScopeFallback = primary.response.status === 400 && (
                primaryErrorSnippet.includes('input.texts should not be null')
                || primaryErrorSnippet.includes('InvalidParameter')
            );

            if (shouldTryDashScopeFallback) {
                const fallback = await requestJson({
                    model: provider.model,
                    input: {
                        texts: [text],
                    },
                    dimensions: DEFAULT_VECTOR_DIMENSIONS,
                    encoding_format: 'float',
                });
                if (fallback.response.ok) {
                    const vector = extractVector(fallback.parsedJson);
                    if (vector && vector.length > 0) {
                        return vector;
                    }
                    throw new Error('embedding response missing vector data');
                }
                throw new Error(`embedding request failed (${fallback.response.status}): ${fallback.rawText.slice(0, 200)}`);
            }

            throw new Error(`embedding request failed (${primary.response.status}): ${primaryErrorSnippet.slice(0, 200)}`);
        } finally {
            clearTimeout(timer);
        }
    }

    private async maybeSyncBeforeSearch(): Promise<void> {
        if (!this.canUsePg()) {
            return;
        }
        if (!this.memoryConfig.retrieval.sync_on_search) {
            return;
        }

        const now = Date.now();
        if (now - this.lastSearchSyncAt < this.memoryConfig.retrieval.sync_min_interval_ms) {
            return;
        }

        await this.syncIncremental();
        this.lastSearchSyncAt = now;
    }

    async search(query: string, scope: MemoryScope): Promise<MemorySearchHit[]> {
        return this.retrieverLayer.search(query, scope);
    }

    async get(path: string, options: MemoryGetOptions | undefined, scope: MemoryScope): Promise<MemoryGetResult> {
        return this.retrieverLayer.get(path, options, scope);
    }

    private splitLinesWithRange(
        content: string,
        range: { from: number; lines: number },
    ): { text: string; fromLine: number; toLine: number; lineCount: number; truncated: boolean } {
        const allLines = content.split('\n');
        const fromIndex = Math.max(0, range.from - 1);
        const picked = allLines.slice(fromIndex, fromIndex + range.lines);
        const lineCount = picked.length;
        const toLine = lineCount > 0 ? (range.from + lineCount - 1) : (range.from - 1);
        const lineTruncated = fromIndex + range.lines < allLines.length;

        let text = picked.join('\n');
        let charTruncated = false;
        if (text.length > MAX_MEMORY_GET_CHARS) {
            text = `${text.slice(0, MAX_MEMORY_GET_CHARS - 1)}…`;
            charTruncated = true;
        }

        return {
            text,
            fromLine: range.from,
            toLine,
            lineCount,
            truncated: lineTruncated || charTruncated,
        };
    }

    private resolveRequestedMemoryPath(path: string): { absPath: string; relPath: string } {
        const absPath = path.startsWith('/')
            ? resolve(path)
            : resolve(this.workspacePath, path);
        const relPath = normalizeRelPath(this.workspacePath, absPath);
        if (!relPath || relPath.startsWith('..')) {
            throw new Error('memory_get path is outside workspace');
        }
        return {
            absPath,
            relPath,
        };
    }

    private isAllowedScopeMemoryPath(relPath: string, scope: MemoryScope): boolean {
        const normalized = relPath.replace(/\\/g, '/');
        if (!normalized.toLowerCase().endsWith('.md')) {
            return false;
        }

        if (scope.key === 'main') {
            if (normalized === 'MEMORY.md') {
                return true;
            }
            if (normalized === 'HEARTBEAT.md') {
                return true;
            }
            if (/^memory\/[^/]+\.md$/u.test(normalized)) {
                return true;
            }
            return normalized.startsWith('memory/scopes/main/');
        }

        const prefix = `memory/scopes/${scope.key}/`;
        return normalized.startsWith(prefix);
    }

    private async readMemoryFile(
        path: string,
        range: { from: number; lines: number },
        scope: MemoryScope,
    ): Promise<MemoryGetResult> {
        const resolved = this.resolveRequestedMemoryPath(path);
        if (!this.isAllowedScopeMemoryPath(resolved.relPath, scope)) {
            throw new Error(`memory_get path is not allowed for scope=${scope.key}: ${resolved.relPath}`);
        }

        const content = await readFile(resolved.absPath, 'utf-8').catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`memory_get failed to read file: ${message}`);
        });

        const chunk = this.splitLinesWithRange(content, range);
        return {
            path: resolved.relPath,
            scope: scope.key,
            source: inferSourceType(resolved.relPath),
            fromLine: chunk.fromLine,
            toLine: chunk.toLine,
            lineCount: chunk.lineCount,
            text: chunk.text,
            truncated: chunk.truncated,
        };
    }

    private parseSessionEventPath(path: string): { sessionKey: string; conversationId: string; eventId: number } | null {
        const normalized = path.replace(/\\/g, '/');
        const match = normalized.match(/^session_events\/([^/]+)\/(.+)\/event-(\d+)$/u);
        if (!match) {
            return null;
        }

        const sessionKey = match[1];
        const conversationId = match[2];
        const eventId = Number(match[3]);
        if (!sessionKey || !conversationId || !Number.isSafeInteger(eventId) || eventId <= 0) {
            return null;
        }
        return { sessionKey, conversationId, eventId };
    }

    private async readSessionEvent(
        path: string,
        range: { from: number; lines: number },
        scope: MemoryScope,
    ): Promise<MemoryGetResult> {
        if (!this.pool || !this.canUsePg()) {
            throw new Error('memory_get session event read requires PGSQL backend');
        }

        const parsed = this.parseSessionEventPath(path);
        if (!parsed) {
            throw new Error(`invalid session event path: ${path}`);
        }
        if (parsed.sessionKey !== scope.key) {
            throw new Error(`cross-scope session event read is not allowed: ${parsed.sessionKey}`);
        }

        const result = await this.pool.query<SessionEventRow>(
            `SELECT role, content
             FROM ${this.sessionEventsTable}
             WHERE id = $1
               AND session_key = $2
               AND conversation_id = $3
             LIMIT 1`,
            [parsed.eventId, parsed.sessionKey, parsed.conversationId]
        );
        const row = result.rows[0];
        if (!row) {
            throw new Error(`session event not found: ${path}`);
        }

        const content = `[${row.role}] ${row.content}`;
        const chunk = this.splitLinesWithRange(content, range);
        return {
            path: path.replace(/\\/g, '/'),
            scope: scope.key,
            source: 'session',
            fromLine: chunk.fromLine,
            toLine: chunk.toLine,
            lineCount: chunk.lineCount,
            text: chunk.text,
            truncated: chunk.truncated,
        };
    }

    private shouldSearchSessionEvents(): boolean {
        return this.canUsePg()
            && this.sessionEventsAvailable
            && this.memoryConfig.retrieval.include_session_events;
    }

    private getSessionEventsLimit(limit: number): number {
        const configured = this.memoryConfig.retrieval.session_events_max_results;
        return Math.max(1, Math.min(Math.max(1, limit), configured));
    }

    private mergeRows(rows: SearchRow[], limit: number): SearchRow[] {
        if (rows.length === 0) {
            return [];
        }
        const deduped = new Map<string, SearchRow>();
        for (const row of sortRowsByScore(rows)) {
            const key = `${row.rel_path}#${row.chunk_index}`;
            if (!deduped.has(key)) {
                deduped.set(key, row);
                if (deduped.size >= limit) {
                    break;
                }
            }
        }
        return Array.from(deduped.values());
    }

    private rowToHit(row: SearchRow, strategy: MemorySearchHit['strategy']): MemorySearchHit {
        return {
            path: row.rel_path,
            startLine: row.start_line,
            endLine: row.end_line,
            score: row.score,
            snippet: summarizeSnippet(row.content),
            source: row.source_type,
            strategy,
        };
    }

    private buildLexicalSqlParts(columnSql: string, query: string, startParamIndex: number): {
        whereSql: string;
        scoreSql: string;
        params: string[];
    } | null {
        const tokens = tokenizeLexicalQuery(query);
        if (tokens.length === 0) {
            return null;
        }

        const whereClauses: string[] = [];
        const scoreClauses: string[] = [];
        const params: string[] = [];
        let index = startParamIndex;

        for (const token of tokens) {
            const rawParam = index;
            index += 1;
            const likeParam = index;
            index += 1;

            params.push(token, `%${escapeLikePattern(token)}%`);
            whereClauses.push(`${columnSql} ILIKE $${likeParam}`);
            scoreClauses.push(
                `CASE
                    WHEN position(lower($${rawParam}) in lower(${columnSql})) > 0
                    THEN 1.0 / (1 + position(lower($${rawParam}) in lower(${columnSql})))
                    ELSE 0
                 END`
            );
        }

        return {
            whereSql: `(${whereClauses.join(' OR ')})`,
            scoreSql: `GREATEST(${scoreClauses.join(', ')})`,
            params,
        };
    }

    private async searchPgKeywordUnified(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        const [chunkRows, sessionRows, temporalRows] = await Promise.all([
            this.searchPgKeyword(query, scopeKey, limit),
            this.searchPgSessionEventsKeyword(query, scopeKey, limit),
            this.searchPgSessionEventsTemporal(query, scopeKey, limit),
        ]);
        return this.mergeRows([...chunkRows, ...sessionRows, ...temporalRows], limit);
    }

    private async searchPgKeyword(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool) return [];

        const lexical = this.buildLexicalSqlParts('content', query, 3);
        if (!lexical) {
            return [];
        }

        const result = await this.pool.query<SearchRow>(
            `SELECT rel_path, chunk_index, start_line, end_line, content, source_type,
                    ${lexical.scoreSql} AS score
             FROM ${this.chunksTable}
             WHERE scope_key = $1
               AND ${lexical.whereSql}
             ORDER BY score DESC, updated_at DESC
             LIMIT $2`,
            [scopeKey, limit, ...lexical.params]
        );

        return result.rows;
    }

    private async searchPgSessionEventsKeyword(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool || !this.shouldSearchSessionEvents()) {
            return [];
        }

        const sessionLimit = this.getSessionEventsLimit(limit);
        const lexical = this.buildLexicalSqlParts('content', query, 3);
        if (!lexical) {
            return [];
        }
        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT
                    ('session_events/' || session_key || '/' || conversation_id || '/event-' || id::text) AS rel_path,
                    0 AS chunk_index,
                    1 AS start_line,
                    1 AS end_line,
                    ('[' || role || '] ' || content) AS content,
                    'session'::text AS source_type,
                    ${lexical.scoreSql} AS score
                 FROM ${this.sessionEventsTable}
                 WHERE session_key = $1
                   AND ${lexical.whereSql}
                 ORDER BY score DESC, created_at DESC
                 LIMIT $2`,
                [scopeKey, sessionLimit, ...lexical.params]
            );
            return result.rows;
        } catch (error) {
            this.handleSessionSearchError(error, 'keyword');
            return [];
        }
    }

    private async searchPgFtsUnified(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        const [chunkRows, sessionRows, temporalRows] = await Promise.all([
            this.searchPgFts(query, scopeKey, limit),
            this.searchPgSessionEventsFts(query, scopeKey, limit),
            this.searchPgSessionEventsTemporal(query, scopeKey, limit),
        ]);
        return this.mergeRows([...chunkRows, ...sessionRows, ...temporalRows], limit);
    }

    private async searchPgFts(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool) return [];

        const ftsQuery = buildFtsQueryText(query);
        if (!ftsQuery) {
            return this.searchPgKeyword(query, scopeKey, limit);
        }

        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT rel_path, chunk_index, start_line, end_line, content, source_type,
                        ts_rank_cd(search_vector, websearch_to_tsquery('simple', $2)) AS score
                 FROM ${this.chunksTable}
                 WHERE scope_key = $1
                   AND search_vector @@ websearch_to_tsquery('simple', $2)
                 ORDER BY score DESC, updated_at DESC
                 LIMIT $3`,
                [scopeKey, ftsQuery, limit]
            );

            if (result.rows.length > 0) {
                return result.rows;
            }
        } catch {
            // fall through to keyword fallback query
        }

        return this.searchPgKeyword(query, scopeKey, limit);
    }

    private async searchPgSessionEventsFts(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool || !this.shouldSearchSessionEvents()) {
            return [];
        }

        const sessionLimit = this.getSessionEventsLimit(limit);
        const ftsQuery = buildFtsQueryText(query);
        if (!ftsQuery) {
            return this.searchPgSessionEventsKeyword(query, scopeKey, limit);
        }
        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT
                    ('session_events/' || session_key || '/' || conversation_id || '/event-' || id::text) AS rel_path,
                    0 AS chunk_index,
                    1 AS start_line,
                    1 AS end_line,
                    ('[' || role || '] ' || content) AS content,
                    'session'::text AS source_type,
                    ts_rank_cd(to_tsvector('simple', content), websearch_to_tsquery('simple', $2)) AS score
                 FROM ${this.sessionEventsTable}
                 WHERE session_key = $1
                   AND to_tsvector('simple', content) @@ websearch_to_tsquery('simple', $2)
                 ORDER BY score DESC, created_at DESC
                 LIMIT $3`,
                [scopeKey, ftsQuery, sessionLimit]
            );

            if (result.rows.length > 0) {
                return result.rows;
            }
        } catch (error) {
            this.handleSessionSearchError(error, 'fts');
            return this.searchPgSessionEventsKeyword(query, scopeKey, limit);
        }

        return this.searchPgSessionEventsKeyword(query, scopeKey, limit);
    }

    private hasTemporalRecallIntent(query: string): boolean {
        return /(昨天|昨日|前天|今天|上次|之前|先前|历史|聊过|问过|还记得|刚才|刚刚)/u.test(query);
    }

    private resolveTemporalWindow(query: string): { startMs: number; endMs: number } | null {
        if (!this.hasTemporalRecallIntent(query)) {
            return null;
        }
        const now = Date.now();
        const current = new Date(now);
        const startToday = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();

        if (/前天/u.test(query)) {
            return {
                startMs: startToday - (2 * ONE_DAY_MS),
                endMs: startToday - ONE_DAY_MS,
            };
        }
        if (/(昨天|昨日)/u.test(query)) {
            return {
                startMs: startToday - ONE_DAY_MS,
                endMs: startToday,
            };
        }
        if (/今天/u.test(query)) {
            return {
                startMs: startToday,
                endMs: now + 1,
            };
        }
        return {
            startMs: now - (TEMPORAL_RECENT_DAYS * ONE_DAY_MS),
            endMs: now + 1,
        };
    }

    private queryPrefersUserRole(query: string): boolean {
        return /(我问|问了什么|问过|提过|历史问题|我说过)/u.test(query);
    }

    private async searchPgSessionEventsTemporal(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool || !this.shouldSearchSessionEvents()) {
            return [];
        }
        if (!this.hasTemporalRecallIntent(query)) {
            return [];
        }

        const window = this.resolveTemporalWindow(query);
        if (!window) {
            return [];
        }
        const prefersUser = this.queryPrefersUserRole(query);
        const candidateLimit = Math.max(limit * 5, 30);
        try {
            const result = await this.pool.query<SessionEventSearchRow>(
                `SELECT id, session_key, conversation_id, role, content, created_at
                 FROM ${this.sessionEventsTable}
                 WHERE session_key = $1
                   AND created_at >= $2
                   AND created_at < $3
                 ORDER BY created_at DESC
                 LIMIT $4`,
                [scopeKey, window.startMs, window.endMs, candidateLimit]
            );
            if (result.rows.length === 0) {
                return [];
            }

            const ranked = result.rows.map((row, index) => {
                const content = `[${row.role}] ${row.content}`;
                const normQuery = query.toLowerCase();
                const normContent = content.toLowerCase();
                const pos = normContent.indexOf(normQuery);
                const lexicalScore = pos >= 0 ? (1 / (1 + pos)) : 0;
                const keywordHint = (/(问|问题)/u.test(query) && /(问|问题)/u.test(content)) ? 0.25 : 0;
                const recencyScore = Math.max(0, 1 - (index / Math.max(1, result.rows.length)));
                const roleBoost = prefersUser && row.role === 'user' ? 0.25 : 0;
                const score = Math.min(1, (0.55 * recencyScore) + (0.35 * lexicalScore) + keywordHint + roleBoost);
                return {
                    row,
                    score,
                };
            });

            ranked.sort((a, b) => {
                if (b.score !== a.score) {
                    return b.score - a.score;
                }
                return Number(b.row.created_at) - Number(a.row.created_at);
            });

            const finalRows = prefersUser
                ? ranked.sort((a, b) => {
                    const aUser = a.row.role === 'user' ? 1 : 0;
                    const bUser = b.row.role === 'user' ? 1 : 0;
                    if (bUser !== aUser) {
                        return bUser - aUser;
                    }
                    if (b.score !== a.score) {
                        return b.score - a.score;
                    }
                    return Number(b.row.created_at) - Number(a.row.created_at);
                })
                : ranked;

            return finalRows
                .slice(0, this.getSessionEventsLimit(limit))
                .map(({ row, score }) => ({
                    rel_path: `session_events/${row.session_key}/${row.conversation_id}/event-${row.id}`,
                    chunk_index: 0,
                    start_line: 1,
                    end_line: 1,
                    content: `[${row.role}] ${row.content}`,
                    source_type: 'session' as const,
                    score,
                }));
        } catch (error) {
            this.handleSessionSearchError(error, 'keyword');
            return [];
        }
    }

    private async searchPgSessionEventsVector(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (
            !this.pool
            || !this.shouldSearchSessionEvents()
            || !this.memoryConfig.embedding.enabled
            || !this.vectorAvailable
            || !this.sessionEventVectorAvailable
        ) {
            return [];
        }

        const queryEmbedding = await this.getOrCreateEmbedding(query, sha256(`session-query:${query}`));
        if (!queryEmbedding || queryEmbedding.length === 0) {
            return [];
        }

        const sessionLimit = this.getSessionEventsLimit(limit);

        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT
                    ('session_events/' || session_key || '/' || conversation_id || '/event-' || id::text) AS rel_path,
                    0 AS chunk_index,
                    1 AS start_line,
                    1 AS end_line,
                    ('[' || role || '] ' || content) AS content,
                    'session'::text AS source_type,
                    (1 - (embedding <=> $2::vector)) AS score
                 FROM ${this.sessionEventsTable}
                 WHERE session_key = $1
                   AND embedding IS NOT NULL
                 ORDER BY embedding <=> $2::vector ASC, created_at DESC
                 LIMIT $3`,
                [scopeKey, toVectorLiteral(queryEmbedding), sessionLimit]
            );
            return result.rows;
        } catch (error) {
            this.handleSessionSearchError(error, 'vector');
            return [];
        }
    }

    private handleSessionSearchError(error: unknown, mode: 'keyword' | 'fts' | 'vector'): void {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : '';
        if (code === '42P01' || code === '42703') {
            this.sessionEventsAvailable = false;
            this.sessionEventVectorAvailable = false;
            this.stopBackgroundWorkers();
        }
        if (mode === 'vector' && (code === '42883' || code === '22P02' || code === 'XX000')) {
            this.sessionEventVectorAvailable = false;
            this.stopSessionEventEmbeddingWorker();
        }
        console.warn(`[Memory] session event ${mode} search failed:`, error instanceof Error ? error.message : String(error));
    }

    private async searchPgVector(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool || !this.vectorAvailable || !this.memoryConfig.embedding.enabled) {
            return [];
        }

        const queryHash = sha256(`query:${query}`);
        const embedding = await this.getOrCreateEmbedding(query, queryHash);
        if (!embedding || embedding.length === 0) {
            return [];
        }

        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT rel_path, chunk_index, start_line, end_line, content, source_type,
                        (1 - (embedding <=> $2::vector)) AS score
                 FROM ${this.chunksTable}
                 WHERE scope_key = $1
                   AND embedding IS NOT NULL
                 ORDER BY embedding <=> $2::vector ASC
                 LIMIT $3`,
                [scopeKey, toVectorLiteral(embedding), limit]
            );

            return result.rows;
        } catch (error) {
            this.vectorAvailable = false;
            console.warn('[Memory] vector search disabled after query failure:', error instanceof Error ? error.message : String(error));
            return [];
        }
    }

    async save(content: string, target: 'daily' | 'long-term', scope: MemoryScope): Promise<MemorySaveResult> {
        return this.storeLayer.save(content, target, scope);
    }

    async saveHeartbeat(content: string, scope: MemoryScope, category?: string): Promise<MemorySaveResult> {
        return this.storeLayer.saveHeartbeat(content, scope, category);
    }

    async appendSessionEvent(params: MemorySessionEventInput): Promise<boolean> {
        if (!this.pool || !this.canUsePg() || !this.sessionEventsAvailable) {
            return false;
        }

        const text = params.content.trim();
        if (!text) {
            return false;
        }

        try {
            await this.pool.query(
                `INSERT INTO ${this.sessionEventsTable} (
                    session_key,
                    conversation_id,
                    channel,
                    role,
                    content,
                    metadata_json,
                    created_at
                ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
                [
                    params.scope.key,
                    params.conversationId,
                    params.channel || null,
                    params.role,
                    text,
                    params.metadata ? JSON.stringify(params.metadata) : null,
                    Math.max(0, Math.floor(params.createdAt ?? Date.now())),
                ]
            );
            return true;
        } catch (error) {
            this.handleSessionEventStorageError(error);
            throw error;
        }
    }

    async appendTranscript(scope: MemoryScope, role: 'user' | 'assistant', content: string): Promise<void> {
        return this.storeLayer.appendTranscript(scope, role, content);
    }

    private resolveScopePaths(scope: MemoryScope): {
        scopeRoot: string;
        dailyDir: string;
        longTermPath: string;
        heartbeatPath: string;
    } {
        return this.storeLayer.resolveScopePaths(scope);
    }

    private async searchFromFiles(query: string, scope: MemoryScope): Promise<MemorySearchHit[]> {
        const normalizedQuery = query.toLowerCase();
        const results: MemorySearchHit[] = [];

        const scopePaths = this.resolveScopePaths(scope);
        const fileSet = new Set<string>();

        if (existsSync(scopePaths.longTermPath)) {
            fileSet.add(scopePaths.longTermPath);
        }
        if (scope.key === 'main') {
            const heartbeatMainPath = join(this.workspacePath, 'HEARTBEAT.md');
            if (existsSync(heartbeatMainPath)) {
                fileSet.add(heartbeatMainPath);
            }
        }

        if (existsSync(scopePaths.dailyDir)) {
            if (scope.key === 'main') {
                const entries = await readdir(scopePaths.dailyDir, { withFileTypes: true }).catch(() => []);
                for (const entry of entries) {
                    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
                    fileSet.add(join(scopePaths.dailyDir, entry.name));
                }
                if (existsSync(scopePaths.scopeRoot)) {
                    const scopedMainFiles: string[] = [];
                    await walkMarkdownFiles(scopePaths.scopeRoot, scopedMainFiles);
                    for (const file of scopedMainFiles) {
                        fileSet.add(file);
                    }
                }
            } else {
                const scopedFiles: string[] = [];
                await walkMarkdownFiles(scopePaths.dailyDir, scopedFiles);
                for (const file of scopedFiles) {
                    fileSet.add(file);
                }
            }
        }

        if (this.memoryConfig.transcript.enabled && scope.key === 'main') {
            const transcriptDir = join(this.workspacePath, 'memory', 'scopes', scope.key, 'transcripts');
            if (existsSync(transcriptDir)) {
                const transcriptFiles: string[] = [];
                await walkMarkdownFiles(transcriptDir, transcriptFiles);
                for (const file of transcriptFiles) {
                    fileSet.add(file);
                }
            }
        }

        const files = Array.from(fileSet);
        for (const file of files) {
            const relPath = normalizeRelPath(this.workspacePath, file);
            const source = inferSourceType(relPath);
            const content = await readFile(file, 'utf-8').catch(() => '');
            if (!content) continue;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i] || '';
                const lowerLine = line.toLowerCase();
                const position = lowerLine.indexOf(normalizedQuery);
                if (position < 0) continue;
                results.push({
                    path: relPath,
                    startLine: i + 1,
                    endLine: i + 1,
                    score: 1 / (1 + position),
                    snippet: summarizeSnippet(line),
                    source,
                    strategy: 'keyword',
                });
            }
        }

        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, this.memoryConfig.retrieval.max_results);
    }
}

const runtimeCache = new Map<string, Promise<MemoryRuntime>>();

function buildRuntimeCacheKey(workspacePath: string, config: Config): string {
    return `${workspacePath}:${JSON.stringify(config.agent.memory)}`;
}

export async function getMemoryRuntime(workspacePath: string, config: Config): Promise<MemoryRuntime> {
    const normalizedWorkspace = resolve(workspacePath);
    const cacheKey = buildRuntimeCacheKey(normalizedWorkspace, config);
    const cached = runtimeCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const created = MemoryRuntime.create(normalizedWorkspace, config).catch((error) => {
        runtimeCache.delete(cacheKey);
        throw error;
    });

    runtimeCache.set(cacheKey, created);
    return created;
}
