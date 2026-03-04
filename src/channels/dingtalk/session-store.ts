import crypto from 'node:crypto';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import type { AgentMemoryConfig, Config } from '../../config.js';
import type { Logger, SessionState } from './types.js';

const DEFAULT_SCHEMA = 'pomelobot_memory';
const SESSION_TABLE = 'dingtalk_sessions';
const SESSION_EVENT_TABLE = 'session_events';
const LEGACY_SESSION_EVENT_TABLE = 'dingtalk_session_events';

interface SessionRow {
    thread_id: string;
    message_history_json: unknown;
    total_tokens: number | string;
    total_input_tokens: number | string;
    total_output_tokens: number | string;
    compaction_count: number | string;
    last_updated: number | string;
}

interface PersistedMessage {
    type: string;
    content: unknown;
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function normalizeScopePart(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return 'main';
    return trimmed.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'main';
}

function coerceNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.floor(value);
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return Math.floor(parsed);
        }
    }
    return fallback;
}

function serializeMessages(messages: BaseMessage[]): PersistedMessage[] {
    return messages.map((message) => ({
        type: message._getType(),
        content: message.content,
    }));
}

function deserializeMessages(raw: unknown): BaseMessage[] {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = [];
        }
    }

    if (!Array.isArray(parsed)) {
        return [];
    }

    const result: BaseMessage[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const record = item as PersistedMessage;
        const content = record.content ?? '';
        switch (record.type) {
        case 'human':
            result.push(new HumanMessage(content as never));
            break;
        case 'ai':
            result.push(new AIMessage(content as never));
            break;
        case 'system':
            result.push(new SystemMessage(content as never));
            break;
        default:
            result.push(new HumanMessage(typeof content === 'string' ? content : JSON.stringify(content)));
            break;
        }
    }

    return result;
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

function shouldUsePgSessionStore(memoryConfig: AgentMemoryConfig): boolean {
    return memoryConfig.backend === 'pgsql' || memoryConfig.pgsql.enabled;
}

function sessionToRow(session: SessionState): {
    history: PersistedMessage[];
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    compactionCount: number;
    lastUpdated: number;
} {
    return {
        history: serializeMessages(session.messageHistory),
        totalTokens: Math.max(0, coerceNumber(session.totalTokens, 0)),
        totalInputTokens: Math.max(0, coerceNumber(session.totalInputTokens, 0)),
        totalOutputTokens: Math.max(0, coerceNumber(session.totalOutputTokens, 0)),
        compactionCount: Math.max(0, coerceNumber(session.compactionCount, 0)),
        lastUpdated: Math.max(0, coerceNumber(session.lastUpdated, Date.now())),
    };
}

export function buildStableThreadId(scopeKey: string): string {
    const normalized = normalizeScopePart(scopeKey);
    const display = normalized.slice(0, 48);
    const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
    return `dingtalk-${display}-${digest}`;
}

export function createSessionThreadId(scopeKey: string): string {
    const stable = buildStableThreadId(scopeKey);
    const nonce = crypto.randomUUID().slice(0, 8);
    return `${stable}-${Date.now().toString(36)}-${nonce}`;
}

export class DingTalkSessionStore {
    private readonly schemaName: string;
    private readonly schemaSql: string;
    private readonly tableSql: string;
    private readonly eventTableSql: string;
    private readonly legacyEventTableSql: string;
    private pool: Pool | null = null;
    private ready = false;

    constructor(private readonly config: Config, private readonly log: Logger) {
        this.schemaName = config.agent.memory.pgsql.schema || DEFAULT_SCHEMA;
        this.schemaSql = quoteIdentifier(this.schemaName);
        this.tableSql = `${this.schemaSql}.${quoteIdentifier(SESSION_TABLE)}`;
        this.eventTableSql = `${this.schemaSql}.${quoteIdentifier(SESSION_EVENT_TABLE)}`;
        this.legacyEventTableSql = `${this.schemaSql}.${quoteIdentifier(LEGACY_SESSION_EVENT_TABLE)}`;
    }

    async initialize(): Promise<boolean> {
        if (this.ready) {
            return true;
        }

        const memoryConfig = this.config.agent.memory;
        if (!shouldUsePgSessionStore(memoryConfig)) {
            return false;
        }

        const poolConfig = buildPgPoolConfig(memoryConfig);
        if (!poolConfig) {
            this.log.warn('[DingTalk] Session store skipped: PG config is incomplete');
            return false;
        }

        try {
            this.pool = new Pool(poolConfig);
            await this.pool.query('SELECT 1');
            await this.ensureSchema();
            this.ready = true;
            this.log.info('[DingTalk] Session store initialized with PGSQL backend');
            return true;
        } catch (error) {
            this.log.warn(`[DingTalk] Session store fallback to memory: ${String(error)}`);
            await this.pool?.end().catch(() => undefined);
            this.pool = null;
            this.ready = false;
            return false;
        }
    }

    async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end().catch(() => undefined);
            this.pool = null;
        }
        this.ready = false;
    }

    async load(sessionKey: string): Promise<SessionState | null> {
        if (!this.ready || !this.pool) {
            return null;
        }

        const result = await this.pool.query<SessionRow>(
            `SELECT thread_id, message_history_json, total_tokens, total_input_tokens, total_output_tokens, compaction_count, last_updated
             FROM ${this.tableSql}
             WHERE session_key = $1`,
            [sessionKey]
        );

        const row = result.rows[0];
        if (!row) {
            return null;
        }

        const persistedThreadId = typeof row.thread_id === 'string' ? row.thread_id.trim() : '';
        return {
            threadId: persistedThreadId || createSessionThreadId(sessionKey),
            messageHistory: deserializeMessages(row.message_history_json),
            totalTokens: Math.max(0, coerceNumber(row.total_tokens, 0)),
            totalInputTokens: Math.max(0, coerceNumber(row.total_input_tokens, 0)),
            totalOutputTokens: Math.max(0, coerceNumber(row.total_output_tokens, 0)),
            compactionCount: Math.max(0, coerceNumber(row.compaction_count, 0)),
            lastUpdated: Math.max(0, coerceNumber(row.last_updated, Date.now())),
        };
    }

    async save(params: { sessionKey: string; scopeKey: string; session: SessionState }): Promise<void> {
        if (!this.ready || !this.pool) {
            return;
        }

        const row = sessionToRow(params.session);
        await this.pool.query(
            `INSERT INTO ${this.tableSql} (
                session_key,
                scope_key,
                thread_id,
                message_history_json,
                total_tokens,
                total_input_tokens,
                total_output_tokens,
                compaction_count,
                last_updated,
                updated_at
            ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (session_key)
            DO UPDATE SET
                scope_key = EXCLUDED.scope_key,
                thread_id = EXCLUDED.thread_id,
                message_history_json = EXCLUDED.message_history_json,
                total_tokens = EXCLUDED.total_tokens,
                total_input_tokens = EXCLUDED.total_input_tokens,
                total_output_tokens = EXCLUDED.total_output_tokens,
                compaction_count = EXCLUDED.compaction_count,
                last_updated = EXCLUDED.last_updated,
                updated_at = NOW()`,
            [
                params.sessionKey,
                normalizeScopePart(params.scopeKey),
                params.session.threadId,
                JSON.stringify(row.history),
                row.totalTokens,
                row.totalInputTokens,
                row.totalOutputTokens,
                row.compactionCount,
                row.lastUpdated,
            ]
        );
    }

    async appendEvent(params: {
        sessionKey: string;
        conversationId: string;
        role: 'user' | 'assistant' | 'summary';
        content: string;
        channel?: string;
        createdAt?: number;
        metadata?: Record<string, unknown>;
    }): Promise<void> {
        if (!this.ready || !this.pool) {
            return;
        }

        const text = params.content.trim();
        if (!text) {
            return;
        }

        await this.pool.query(
            `INSERT INTO ${this.eventTableSql} (
                session_key,
                conversation_id,
                channel,
                role,
                content,
                metadata_json,
                created_at
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [
                params.sessionKey,
                params.conversationId,
                params.channel || 'dingtalk',
                params.role,
                text,
                params.metadata ? JSON.stringify(params.metadata) : null,
                Math.max(0, Math.floor(params.createdAt ?? Date.now())),
            ]
        );
    }

    async deleteExpired(cutoffMs: number): Promise<number> {
        if (!this.ready || !this.pool) {
            return 0;
        }

        const result = await this.pool.query(
            `DELETE FROM ${this.tableSql} WHERE last_updated < $1`,
            [Math.max(0, Math.floor(cutoffMs))]
        );
        return result.rowCount ?? 0;
    }

    private async ensureSchema(): Promise<void> {
        if (!this.pool) return;

        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);
        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.tableSql} (
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
            )`
        );

        await this.pool.query(
            `ALTER TABLE ${this.tableSql}
             ADD COLUMN IF NOT EXISTS session_key TEXT`
        );
        await this.pool.query(
            `UPDATE ${this.tableSql}
             SET session_key = scope_key
             WHERE session_key IS NULL`
        );
        await this.pool.query(
            `DELETE FROM ${this.tableSql} AS target
             USING (
                SELECT ctid,
                       row_number() OVER (
                           PARTITION BY session_key
                           ORDER BY last_updated DESC, updated_at DESC, created_at DESC
                       ) AS rn
                FROM ${this.tableSql}
                WHERE session_key IS NOT NULL
             ) AS ranked
             WHERE target.ctid = ranked.ctid
               AND ranked.rn > 1`
        );
        await this.pool.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS dingtalk_sessions_session_key_uidx
             ON ${this.tableSql} (session_key)`
        );

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.eventTableSql} (
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
            `ALTER TABLE ${this.eventTableSql}
             ADD COLUMN IF NOT EXISTS channel TEXT`
        );
        await this.pool.query(
            `ALTER TABLE ${this.eventTableSql}
             ADD COLUMN IF NOT EXISTS metadata_json JSONB`
        );
        await this.pool.query(
            `ALTER TABLE ${this.eventTableSql}
             ADD COLUMN IF NOT EXISTS inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
        );
        await this.migrateLegacySessionEventsTable();
        await this.pool.query(
            `CREATE INDEX IF NOT EXISTS session_events_session_idx
             ON ${this.eventTableSql} (session_key, created_at DESC)`
        );
        await this.pool.query(
            `CREATE INDEX IF NOT EXISTS session_events_conversation_idx
             ON ${this.eventTableSql} (conversation_id, created_at DESC)`
        );
        await this.pool.query(
            `CREATE INDEX IF NOT EXISTS session_events_fts_idx
             ON ${this.eventTableSql}
             USING GIN (to_tsvector('simple', coalesce(content, '')))`
        );

        await this.pool.query(
            `CREATE INDEX IF NOT EXISTS dingtalk_sessions_scope_idx
             ON ${this.tableSql} (scope_key)`
        );
        await this.pool.query(
            `CREATE INDEX IF NOT EXISTS dingtalk_sessions_updated_idx
             ON ${this.tableSql} (last_updated DESC)`
        );
    }

    private async migrateLegacySessionEventsTable(): Promise<void> {
        if (!this.pool || this.legacyEventTableSql === this.eventTableSql) {
            return;
        }

        const legacyExists = await this.pool.query<{ exists: boolean }>(
            `SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = $1
                  AND table_name = $2
            ) AS exists`,
            [this.schemaName, LEGACY_SESSION_EVENT_TABLE]
        );
        if (!legacyExists.rows[0]?.exists) {
            return;
        }

        await this.pool.query(
            `ALTER TABLE ${this.legacyEventTableSql}
             ADD COLUMN IF NOT EXISTS channel TEXT`
        ).catch(() => undefined);

        await this.pool.query(
            `INSERT INTO ${this.eventTableSql} (
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
            FROM ${this.legacyEventTableSql} AS legacy
            LEFT JOIN ${this.eventTableSql} AS current
              ON current.session_key = legacy.session_key
             AND current.conversation_id = legacy.conversation_id
             AND current.role = legacy.role
             AND current.content = legacy.content
             AND current.created_at = legacy.created_at
            WHERE current.id IS NULL`
        );
    }
}
