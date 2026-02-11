/**
 * DingTalk Message Handler
 * Handles incoming messages and agent interaction
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import type { DingTalkConfig, CompactionConfig } from '../../config.js';
import type {
    DingTalkInboundMessage,
    MessageContent,
    SessionState,
    Logger,
    AICardInstance,
    AICardState,
} from './types.js';
import {
    sendBySession,
    sendProactiveFile,
    createAICard,
    streamAICard,
    finishAICard,
    isCardFinished,
    getActiveAICard,
    cleanupCardCache,
    downloadMedia,
} from './client.js';
import { AICardStatus } from './types.js';
import { hasPendingApprovalForKey, tryHandleExecApprovalReply } from './approvals.js';
import {
    createMemoryFlushState,
    estimateTokens,
    updateTokenCount,
    shouldTriggerMemoryFlush,
    markFlushCompleted,
    isNoReplyResponse,
    buildMemoryFlushPrompt,
    recordSessionTranscript,
    type MemoryFlushState,
} from '../../middleware/index.js';
import {
    shouldAutoCompact,
    compactMessages,
    formatTokenCount,
    getContextUsageInfo,
} from '../../compaction/index.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Config } from '../../config.js';
import {
    createChatModel,
    getActiveModelEntry,
    getActiveModelAlias,
    getModelCacheKey,
    listConfiguredModels,
} from '../../llm.js';
import { HumanMessage as LCHumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { withDingTalkConversationContext, consumeQueuedDingTalkReplyFiles } from './context.js';
import { resolveMemoryScope } from '../../middleware/memory-scope.js';
import { DingTalkSessionStore, buildStableThreadId } from './session-store.js';

// Session state cache (scopeKey -> SessionState)
const sessionCache = new Map<string, SessionState>();
let cachedCompactionModel: BaseChatModel | null = null;
let cachedCompactionModelKey = '';
let sessionStore: DingTalkSessionStore | null = null;
let sessionStoreConfigKey = '';
let sessionStoreInitPromise: Promise<DingTalkSessionStore | null> | null = null;
let lastSessionStoreCleanupAt = 0;
const hydratedThreadIds = new Set<string>();

// Per-conversation processing queue to ensure serial handling
const conversationQueue = new Map<string, Promise<void>>();

// Session TTL (2 hours)
const SESSION_TTL = 2 * 60 * 60 * 1000;
const SESSION_STORE_CLEANUP_INTERVAL = 10 * 60 * 1000;
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_TEXT_FILE_CHARS = 6000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_FRAMES = 3;
const MAX_REPLY_FILES = 3;
const MAX_REPLY_FILE_BYTES = 10 * 1024 * 1024;
const STARTUP_MEMORY_MAX_FILES = 2;
const STARTUP_MEMORY_MAX_LINES_PER_FILE = 80;
const STARTUP_MEMORY_MAX_FILE_CHARS = 1200;
const STARTUP_MEMORY_MAX_TOTAL_CHARS = 2400;
const commandAvailabilityCache = new Map<string, boolean>();
const execFileAsync = promisify(execFileCallback);
const DINGTALK_FILE_TAG_PATTERN = /<dingtalk-file\s+path=(?:"([^"]+)"|'([^']+)')\s*\/?>/gi;
const FILE_OUTPUT_LINE_PATTERN = /^FILE_OUTPUT:\s*(.+)$/gim;
const USER_FILE_TRANSFER_INTENT_PATTERN = /(回传|发送|发我|发给我|传给我|给我|下载|附件|文件)/;
const WORKSPACE_PATH_HINT_PATTERN = /(^|[\s"'`(（\[])(\.?\/?workspace\/[^\s"'`)\]）>]+)/g;
const MINIMAX_TOOL_CALL_TAG_PATTERN = /<\s*minimax:tool_call\b[\s\S]*?(?:<\/\s*minimax:tool_call\s*>|$)/gi;
const MINIMAX_TOOL_CALL_CLOSE_TAG_PATTERN = /<\/\s*minimax:tool_call\s*>/gi;
const GENERIC_TOOL_CALL_TAG_PATTERN = /<\s*\/?\s*tool_call\b[^>]*>/gi;
const TOOL_CALL_HINT_PATTERN = /\[\s*调用工具:[^\]\n]*\]/g;
const TOOL_CALL_INLINE_NAME_PATTERN = /\[\s*调用\s+name=["'][^"']+["'][^\]\n]*\]/g;
const TOOL_CALL_TRAIL_PATTERN = /\[\s*调用(?:工具|参数)?:[^\n]*/g;
const TOOL_CALL_RESIDUE_PATTERN = /(调用工具|调用参数|tool_call|minimax:tool_call|^\s*调用\s+name=|^\s*name\s*=\s*["'])/i;

const TEXT_MIME_HINTS = [
    'text/',
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/x-javascript',
    'application/csv',
];

const TEXT_FILE_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.csv', '.ts', '.tsx',
    '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rb', '.php', '.sql', '.sh',
    '.bash', '.zsh', '.ini', '.toml', '.conf', '.log', '.env',
]);

function enqueueConversationTask(
    conversationId: string,
    task: () => Promise<void>
): Promise<void> {
    const previous = conversationQueue.get(conversationId) ?? Promise.resolve();
    const next = previous.then(task, task).finally(() => {
        if (conversationQueue.get(conversationId) === next) {
            conversationQueue.delete(conversationId);
        }
    });
    conversationQueue.set(conversationId, next);
    return next;
}

/**
 * Extract message content from DingTalk message
 */
export function extractMessageContent(data: DingTalkInboundMessage): MessageContent {
    const msgtype = data.msgtype || 'text';

    if (msgtype === 'text') {
        return { text: data.text?.content?.trim() || '', messageType: 'text' };
    }

    if (msgtype === 'richText') {
        const richTextParts = data.content?.richText || [];
        let text = '';
        for (const part of richTextParts) {
            if (part.type === 'text' && part.text) text += part.text;
            if (part.type === 'at' && part.atName) text += `@${part.atName} `;
        }
        return { text: text.trim() || '[富文本消息]', messageType: 'richText' };
    }

    if (msgtype === 'picture') {
        return { text: '[图片]', mediaPath: data.content?.downloadCode, mediaType: 'image', messageType: 'picture' };
    }

    if (msgtype === 'audio') {
        return {
            text: data.content?.recognition || '[语音消息]',
            mediaPath: data.content?.downloadCode,
            mediaType: 'audio',
            messageType: 'audio',
        };
    }

    if (msgtype === 'video') {
        return { text: '[视频]', mediaPath: data.content?.downloadCode, mediaType: 'video', messageType: 'video' };
    }

    if (msgtype === 'file') {
        return {
            text: `[文件: ${data.content?.fileName || '文件'}]`,
            mediaPath: data.content?.downloadCode,
            mediaType: 'file',
            messageType: 'file',
        };
    }

    // Fallback
    return { text: data.text?.content?.trim() || `[${msgtype}消息]`, messageType: msgtype };
}

/**
 * Get or create session state for a conversation
 */
async function getOrCreateSession(params: {
    sessionKey: string;
    scopeKey: string;
    store: DingTalkSessionStore | null;
    log: Logger;
}): Promise<SessionState> {
    const { sessionKey, scopeKey, store, log } = params;
    const existing = sessionCache.get(sessionKey);
    if (existing && Date.now() - existing.lastUpdated < SESSION_TTL) {
        return existing;
    }

    if (store) {
        try {
            const persisted = await store.load(sessionKey);
            if (persisted && Date.now() - persisted.lastUpdated < SESSION_TTL) {
                sessionCache.set(sessionKey, persisted);
                return persisted;
            }
        } catch (error) {
            log.warn(`[DingTalk] Failed to load persisted session for ${sessionKey}: ${String(error)}`);
        }
    }

    const newSession: SessionState = {
        threadId: buildStableThreadId(scopeKey),
        messageHistory: [],
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        compactionCount: 0,
        lastUpdated: Date.now(),
    };
    sessionCache.set(sessionKey, newSession);

    if (store) {
        try {
            await store.save({ sessionKey, scopeKey, session: newSession });
        } catch (error) {
            log.warn(`[DingTalk] Failed to persist new session ${sessionKey}: ${String(error)}`);
        }
    }

    return newSession;
}

/**
 * Clean up expired sessions
 */
async function cleanupSessions(
    store: DingTalkSessionStore | null,
    log: Logger
): Promise<void> {
    const now = Date.now();
    for (const [id, session] of sessionCache.entries()) {
        if (now - session.lastUpdated > SESSION_TTL) {
            sessionCache.delete(id);
            hydratedThreadIds.delete(session.threadId);
        }
    }

    if (!store) {
        return;
    }
    if (now - lastSessionStoreCleanupAt < SESSION_STORE_CLEANUP_INTERVAL) {
        return;
    }

    lastSessionStoreCleanupAt = now;
    try {
        const deleted = await store.deleteExpired(now - SESSION_TTL);
        if (deleted > 0) {
            log.info(`[DingTalk] Cleaned ${deleted} expired persisted sessions`);
        }
    } catch (error) {
        log.warn(`[DingTalk] Persisted session cleanup failed: ${String(error)}`);
    }
}

function getSessionStoreConfigKey(config: Config): string {
    const memory = config.agent.memory;
    const pg = memory.pgsql;
    return JSON.stringify({
        backend: memory.backend,
        enabled: pg.enabled,
        connection_string: pg.connection_string || '',
        host: pg.host || '',
        port: pg.port,
        user: pg.user || '',
        database: pg.database || '',
        ssl: pg.ssl,
        schema: pg.schema || 'pomelobot_memory',
    });
}

async function getSessionStore(config: Config, log: Logger): Promise<DingTalkSessionStore | null> {
    const key = getSessionStoreConfigKey(config);
    if (sessionStore && sessionStoreConfigKey === key) {
        return sessionStore;
    }

    if (sessionStoreInitPromise && sessionStoreConfigKey === key) {
        return sessionStoreInitPromise;
    }

    if (sessionStore && sessionStoreConfigKey !== key) {
        await sessionStore.close().catch(() => undefined);
        sessionStore = null;
    }

    sessionStoreConfigKey = key;
    sessionStoreInitPromise = (async () => {
        const store = new DingTalkSessionStore(config, log);
        const initialized = await store.initialize();
        if (!initialized) {
            await store.close().catch(() => undefined);
            return null;
        }
        sessionStore = store;
        return store;
    })().finally(() => {
        sessionStoreInitPromise = null;
    });

    return sessionStoreInitPromise;
}

async function persistSession(params: {
    sessionKey: string;
    scopeKey: string;
    session: SessionState;
    store: DingTalkSessionStore | null;
    log: Logger;
}): Promise<void> {
    if (!params.store) {
        return;
    }
    try {
        await params.store.save({
            sessionKey: params.sessionKey,
            scopeKey: params.scopeKey,
            session: params.session,
        });
    } catch (error) {
        params.log.warn(`[DingTalk] Failed to persist session ${params.sessionKey}: ${String(error)}`);
    }
}

async function persistSessionEvent(params: {
    role: 'user' | 'assistant' | 'summary';
    content: string;
    conversationId: string;
    sessionKey: string;
    store: DingTalkSessionStore | null;
    workspacePath: string;
    config: Config;
    log: Logger;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const text = params.content.trim();
    if (!text) {
        return;
    }

    if (params.store) {
        await params.store.appendEvent({
            sessionKey: params.sessionKey,
            conversationId: params.conversationId,
            role: params.role,
            content: text,
            metadata: params.metadata,
        }).catch((error) => {
            params.log.warn(`[DingTalk] Failed to persist session event (${params.role}): ${String(error)}`);
        });
        return;
    }

    if (params.role === 'summary') {
        await recordSessionTranscript(params.workspacePath, params.config, 'assistant', `[压缩摘要] ${text}`)
            .catch((error) => params.log.debug('[DingTalk] Transcript(summary) write skipped:', String(error)));
        return;
    }

    const fallbackRole = params.role === 'assistant' ? 'assistant' : 'user';
    await recordSessionTranscript(params.workspacePath, params.config, fallbackRole, text)
        .catch((error) => params.log.debug(`[DingTalk] Transcript(${fallbackRole}) write skipped:`, String(error)));
}

/**
 * Get or create a shared compaction model from config
 */
async function getCompactionModel(config: Config): Promise<BaseChatModel> {
    const modelKey = getModelCacheKey(config);

    if (cachedCompactionModel && cachedCompactionModelKey === modelKey) {
        return cachedCompactionModel;
    }

    cachedCompactionModel = await createChatModel(config, { temperature: 0 });

    cachedCompactionModelKey = modelKey;
    return cachedCompactionModel;
}

function normalizeMimeType(mimeType: string | undefined): string {
    if (!mimeType) return 'application/octet-stream';
    return mimeType.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}

function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function extractTextFromModelContent(content: unknown): string {
    if (typeof content === 'string') {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return '';
    }

    const chunks: string[] = [];
    for (const block of content) {
        if (typeof block === 'string') {
            chunks.push(block);
            continue;
        }
        if (!block || typeof block !== 'object') {
            continue;
        }
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') {
            chunks.push(text);
        }
    }
    return chunks.join('\n').trim();
}

function hasMemoryRecallIntent(text: string): boolean {
    return /(你还记得|还记得吗|之前|上次|昨天|昨日|前天|刚才|刚刚|问过|聊过|历史|回顾|回溯|做过什么|提过什么)/u.test(text);
}

function formatLocalDateWithOffset(baseDate: Date, offsetDays: number): string {
    const date = new Date(baseDate.getTime() + (offsetDays * 24 * 60 * 60 * 1000));
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function resolveScopedDailyMemoryPath(workspacePath: string, scopeKey: string, dateKey: string): string {
    if (scopeKey === 'main') {
        return path.join(workspacePath, 'memory', `${dateKey}.md`);
    }
    return path.join(workspacePath, 'memory', 'scopes', scopeKey, `${dateKey}.md`);
}

function compactStartupMemoryText(content: string): string {
    const lines = content
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
    const tail = lines.slice(-STARTUP_MEMORY_MAX_LINES_PER_FILE);
    const merged = tail.join('\n').trim();
    if (merged.length <= STARTUP_MEMORY_MAX_FILE_CHARS) {
        return merged;
    }
    return `${merged.slice(0, Math.max(0, STARTUP_MEMORY_MAX_FILE_CHARS - 1))}…`;
}

function trimInjectionByTotalChars(blocks: string[], maxChars: number): string[] {
    if (maxChars <= 0) {
        return [];
    }
    const output: string[] = [];
    let used = 0;
    for (const block of blocks) {
        if (!block) {
            continue;
        }
        const remaining = maxChars - used;
        if (remaining <= 0) {
            break;
        }
        if (block.length <= remaining) {
            output.push(block);
            used += block.length;
            continue;
        }
        if (remaining >= 20) {
            output.push(`${block.slice(0, Math.max(0, remaining - 1))}…`);
            used = maxChars;
        }
        break;
    }
    return output;
}

async function buildSessionStartupMemoryInjection(params: {
    workspacePath: string;
    scopeKey: string;
    now?: Date;
}): Promise<string | null> {
    const now = params.now ?? new Date();
    const dateKeys = [
        formatLocalDateWithOffset(now, 0),
        formatLocalDateWithOffset(now, -1),
    ];
    const snippets: string[] = [];

    for (const dateKey of dateKeys.slice(0, STARTUP_MEMORY_MAX_FILES)) {
        const absPath = resolveScopedDailyMemoryPath(params.workspacePath, params.scopeKey, dateKey);
        let raw = '';
        try {
            raw = await fsPromises.readFile(absPath, 'utf-8');
        } catch {
            continue;
        }
        const compact = compactStartupMemoryText(raw);
        if (!compact || compact.length < 20) {
            continue;
        }
        const relPath = path.relative(params.workspacePath, absPath).replace(/\\/g, '/');
        snippets.push(`### ${dateKey} (${relPath})\n${compact}`);
    }

    if (snippets.length === 0) {
        return null;
    }

    const header = [
        '【会话启动记忆注入（今昨摘要）】',
        '以下内容来自 Markdown 记忆文件（非向量库），仅作首轮上下文补充。',
        '若用户追问历史细节，仍应调用 memory_search / memory_get 取证。',
        '',
    ].join('\n');
    const bodyBlocks = trimInjectionByTotalChars(snippets, Math.max(0, STARTUP_MEMORY_MAX_TOTAL_CHARS - header.length));
    if (bodyBlocks.length === 0) {
        return null;
    }
    return `${header}${bodyBlocks.join('\n\n')}`;
}

function buildMemorySearchEnforcedPrompt(userText: string): string {
    return [
        '【记忆检索强制规则】',
        '当前问题属于历史回溯类问题。',
        '你必须先调用 memory_search 检索，再基于检索结果回答。',
        '若需要精确引用，再调用 memory_get 读取命中片段。',
        '如果检索不到，请明确说明“已检索但未找到足够信息”，禁止直接凭空回答。',
        '',
        `用户原问题：${userText}`,
    ].join('\n');
}

function buildDingTalkAgentMessagesWithPolicy(
    userText: string,
    options?: { enforceMemorySearch?: boolean; startupMemoryInjection?: string | null },
): Array<{ role: 'user'; content: string }> {
    const messages: Array<{ role: 'user'; content: string }> = [];
    if (options?.startupMemoryInjection) {
        messages.push({
            role: 'user',
            content: [
                '【会话启动上下文】',
                options.startupMemoryInjection,
                '',
                '以上是会话启动补充信息，请结合当前问题作答。',
            ].join('\n'),
        });
    }
    if (options?.enforceMemorySearch) {
        messages.push({ role: 'user', content: buildMemorySearchEnforcedPrompt(userText) });
        return messages;
    }
    messages.push({ role: 'user', content: userText });
    return messages;
}

function normalizeHistoryContent(content: unknown): string {
    if (typeof content === 'string') {
        return content.trim();
    }

    if (Array.isArray(content)) {
        const chunks: string[] = [];
        for (const item of content) {
            if (typeof item === 'string') {
                chunks.push(item);
                continue;
            }
            if (!item || typeof item !== 'object') {
                continue;
            }
            const text = (item as { text?: unknown }).text;
            if (typeof text === 'string') {
                chunks.push(text);
            }
        }
        return chunks.join('\n').trim();
    }

    if (content === null || content === undefined) {
        return '';
    }

    try {
        return JSON.stringify(content);
    } catch {
        return String(content);
    }
}

function toAgentHistoryMessage(message: BaseMessage): { role: 'system' | 'assistant' | 'user'; content: string } | null {
    const content = normalizeHistoryContent(message.content);
    if (!content) {
        return null;
    }

    switch (message._getType()) {
    case 'system':
        return { role: 'system', content };
    case 'ai':
        return { role: 'assistant', content };
    case 'human':
        return { role: 'user', content };
    default:
        return null;
    }
}

function buildAgentInvocationMessages(
    session: SessionState,
    userText: string,
    options?: { enforceMemorySearch?: boolean; startupMemoryInjection?: string | null },
): Array<{ role: 'system' | 'assistant' | 'user'; content: string }> {
    if (hydratedThreadIds.has(session.threadId)) {
        return normalizeInvocationMessages(buildDingTalkAgentMessagesWithPolicy(userText, options));
    }

    const history = session.messageHistory
        .map((message) => toAgentHistoryMessage(message))
        .filter((item): item is { role: 'system' | 'assistant' | 'user'; content: string } => Boolean(item));

    if (history.length === 0) {
        return normalizeInvocationMessages(buildDingTalkAgentMessagesWithPolicy(userText, options));
    }

    return normalizeInvocationMessages([
        ...history,
        ...buildDingTalkAgentMessagesWithPolicy(userText, options),
    ]);
}

function normalizeInvocationMessages(
    messages: Array<{ role: 'system' | 'assistant' | 'user'; content: string }>
): Array<{ role: 'system' | 'assistant' | 'user'; content: string }> {
    if (messages.length === 0) {
        return messages;
    }

    const normalized: Array<{ role: 'system' | 'assistant' | 'user'; content: string }> = [];
    let hasSystemAtFirst = false;

    for (const message of messages) {
        if (message.role !== 'system') {
            normalized.push(message);
            continue;
        }

        if (!hasSystemAtFirst && normalized.length === 0) {
            normalized.push(message);
            hasSystemAtFirst = true;
            continue;
        }

        normalized.push({
            role: 'user',
            content: `【系统上下文转述】\n${message.content}`,
        });
    }

    return normalized;
}

function cleanPotentialFilePath(raw: string): string {
    const trimmed = raw
        .trim()
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/[，。；！？,.!?]+$/g, '');
    if (!trimmed) return '';
    if (/^[a-z]+:\/\//i.test(trimmed)) return '';
    return trimmed;
}

function collectWorkspacePathHints(text: string): string[] {
    const paths: string[] = [];
    WORKSPACE_PATH_HINT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WORKSPACE_PATH_HINT_PATTERN.exec(text)) !== null) {
        const candidate = cleanPotentialFilePath(match[2] || '');
        if (candidate) {
            paths.push(candidate);
        }
    }
    return paths;
}

function sanitizeAssistantReplyText(text: string): string {
    if (!text) return '';
    let cleaned = text;
    cleaned = cleaned.replace(MINIMAX_TOOL_CALL_TAG_PATTERN, '');
    cleaned = cleaned.replace(MINIMAX_TOOL_CALL_CLOSE_TAG_PATTERN, '');
    cleaned = cleaned.replace(GENERIC_TOOL_CALL_TAG_PATTERN, '');
    cleaned = cleaned.replace(TOOL_CALL_HINT_PATTERN, '');
    cleaned = cleaned.replace(TOOL_CALL_INLINE_NAME_PATTERN, '');
    cleaned = cleaned.replace(TOOL_CALL_TRAIL_PATTERN, '');
    cleaned = cleaned
        .split('\n')
        .filter((line) => !TOOL_CALL_RESIDUE_PATTERN.test(line.trim()))
        .join('\n');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
}

function extractTextBlocks(content: unknown): string {
    if (typeof content === 'string') {
        return content.trim();
    }
    if (content && typeof content === 'object' && !Array.isArray(content)) {
        const obj = content as {
            text?: unknown;
            content?: unknown;
            kwargs?: { text?: unknown; content?: unknown };
        };
        if (typeof obj.text === 'string' && obj.text.trim()) {
            return obj.text.trim();
        }
        if (obj.content !== undefined) {
            return extractTextBlocks(obj.content);
        }
        if (obj.kwargs) {
            if (obj.kwargs.content !== undefined) {
                return extractTextBlocks(obj.kwargs.content);
            }
            if (obj.kwargs.text !== undefined) {
                return extractTextBlocks(obj.kwargs.text);
            }
        }
        return '';
    }
    if (!Array.isArray(content)) {
        return '';
    }
    const blocks: string[] = [];
    for (const item of content) {
        if (typeof item === 'string') {
            blocks.push(item);
            continue;
        }
        if (!item || typeof item !== 'object') {
            continue;
        }
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
            blocks.push(text);
        }
    }
    return blocks.join('\n').trim();
}

function extractReplyTextFromEventData(data: unknown, depth: number = 0): string {
    if (!data || depth > 3) {
        return '';
    }
    if (typeof data === 'string' || Array.isArray(data)) {
        return extractTextBlocks(data);
    }
    if (typeof data !== 'object') {
        return '';
    }

    const record = data as Record<string, unknown> & { kwargs?: { content?: unknown; output?: unknown; messages?: unknown } };
    const directContent = extractTextBlocks(record.content !== undefined ? record.content : record.kwargs?.content);
    if (directContent) {
        return directContent;
    }

    const messages = Array.isArray(record.messages)
        ? record.messages
        : Array.isArray(record.kwargs?.messages)
            ? record.kwargs.messages
            : null;
    if (messages && messages.length > 0) {
        const lastMessage = messages[messages.length - 1] as { content?: unknown } | undefined;
        if (lastMessage) {
            const messageContent = extractTextBlocks(lastMessage.content);
            if (messageContent) {
                return messageContent;
            }
        }
    }

    if ('output' in record) {
        return extractReplyTextFromEventData(record.output, depth + 1);
    }
    if (record.kwargs && 'output' in record.kwargs) {
        return extractReplyTextFromEventData(record.kwargs.output, depth + 1);
    }
    return '';
}

function getMessageRole(message: unknown): string {
    if (!message || typeof message !== 'object') {
        return '';
    }
    const msg = message as {
        _getType?: unknown;
        type?: unknown;
        role?: unknown;
        kwargs?: { type?: unknown; role?: unknown };
    };
    if (typeof msg._getType === 'function') {
        try {
            const role = (msg._getType as () => string)();
            if (typeof role === 'string') {
                return role.toLowerCase();
            }
        } catch {
            // ignore
        }
    }
    if (typeof msg.type === 'string' && msg.type.trim()) {
        return msg.type.toLowerCase();
    }
    if (typeof msg.role === 'string' && msg.role.trim()) {
        return msg.role.toLowerCase();
    }
    if (msg.kwargs) {
        if (typeof msg.kwargs.type === 'string' && msg.kwargs.type.trim()) {
            return msg.kwargs.type.toLowerCase();
        }
        if (typeof msg.kwargs.role === 'string' && msg.kwargs.role.trim()) {
            return msg.kwargs.role.toLowerCase();
        }
    }
    return '';
}

function isLikelyToolCallResidue(text: string): boolean {
    const cleaned = sanitizeAssistantReplyText(text);
    if (!cleaned) return true;
    if (TOOL_CALL_RESIDUE_PATTERN.test(cleaned)) return true;
    if (/(minimax:tool_call|tool_call)/i.test(cleaned)) return true;
    if (/^[\s\]\[}{(),.:;'"`\\/-]+$/.test(cleaned)) return true;
    const total = cleaned.length;
    const readable = (cleaned.match(/[A-Za-z0-9\u4e00-\u9fa5]/g) || []).length;
    const braces = (cleaned.match(/[{}\[\]]/g) || []).length;
    if (total >= 40 && readable / total < 0.15 && braces / total > 0.3) {
        return true;
    }
    return false;
}

function isLikelyStructuredToolPayload(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;

    const fenced = trimmed.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
    const body = (fenced?.[1] || trimmed).trim();
    if (!body) return false;
    if (!(body.startsWith('{') || body.startsWith('['))) {
        return false;
    }

    const compact = body.replace(/\s+/g, ' ');
    const kvLike = (compact.match(/":/g) || []).length;
    const objLike = (compact.match(/,\s*"/g) || []).length;
    const weatherLike = /(forecasts?|dayweather|nightweather|daytemp|nighttemp|temperature|humidity|wind|province|city|adcode)/i.test(compact);

    return kvLike >= 4 || objLike >= 4 || weatherLike;
}

function extractBestReadableReplyFromMessages(messages: unknown[]): string {
    let fallback = '';

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || typeof message !== 'object') {
            continue;
        }
        const role = getMessageRole(message);
        const msg = message as { content?: unknown; kwargs?: { content?: unknown } };
        const content = extractTextBlocks(msg.content !== undefined ? msg.content : msg.kwargs?.content);
        const cleaned = sanitizeAssistantReplyText(content);
        if (!cleaned) {
            continue;
        }
        if (!fallback) {
            fallback = cleaned;
        }
        if ((role === 'ai' || role === 'assistant') && !isLikelyToolCallResidue(cleaned)) {
            return cleaned;
        }
    }

    if (fallback && !isLikelyToolCallResidue(fallback)) {
        return fallback;
    }
    return '';
}

function pickBestUserFacingResponse(
    candidates: string[],
    options?: {
        sawToolCall?: boolean;
    }
): string {
    const sawToolCall = options?.sawToolCall === true;
    let fallback = '';
    for (const candidate of candidates) {
        const cleaned = sanitizeAssistantReplyText(candidate);
        if (!cleaned) {
            continue;
        }
        if (isLikelyToolCallResidue(cleaned)) {
            continue;
        }
        if (!fallback) {
            fallback = cleaned;
        }
        if (sawToolCall && isLikelyStructuredToolPayload(cleaned)) {
            continue;
        }
        return cleaned;
    }
    return fallback;
}

function collectReplyPathHints(text: string): { cleanedText: string; candidates: string[] } {
    const candidates: string[] = [];
    DINGTALK_FILE_TAG_PATTERN.lastIndex = 0;
    FILE_OUTPUT_LINE_PATTERN.lastIndex = 0;

    const pushCandidate = (raw: string) => {
        const cleaned = cleanPotentialFilePath(raw);
        if (cleaned) {
            candidates.push(cleaned);
        }
    };

    let cleanedText = text.replace(DINGTALK_FILE_TAG_PATTERN, (_match, g1: string, g2: string) => {
        pushCandidate(g1 || g2 || '');
        return '';
    });
    cleanedText = cleanedText.replace(FILE_OUTPUT_LINE_PATTERN, (_match, g1: string) => {
        pushCandidate(g1 || '');
        return '';
    });

    cleanedText = sanitizeAssistantReplyText(cleanedText);
    return {
        cleanedText: cleanedText || sanitizeAssistantReplyText(text),
        candidates,
    };
}

function resolvePathInWorkspace(rawPath: string, workspaceRoot: string): string | null {
    const normalizedWorkspace = path.resolve(workspaceRoot);
    const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(process.cwd(), rawPath);
    if (resolved === normalizedWorkspace) return null;
    if (!resolved.startsWith(`${normalizedWorkspace}${path.sep}`)) {
        return null;
    }
    return resolved;
}

function isPathInsideDir(targetPath: string, dirPath: string): boolean {
    const normalizedDir = path.resolve(dirPath);
    const normalizedTarget = path.resolve(targetPath);
    return normalizedTarget === normalizedDir || normalizedTarget.startsWith(`${normalizedDir}${path.sep}`);
}

async function ensureReplyFileUnderTmp(params: {
    filePath: string;
    workspaceRoot: string;
    log: Logger;
}): Promise<string | null> {
    const tmpRoot = path.resolve(params.workspaceRoot, 'tmp');
    const resolved = path.resolve(params.filePath);
    if (isPathInsideDir(resolved, tmpRoot)) {
        return resolved;
    }

    try {
        await fsPromises.mkdir(tmpRoot, { recursive: true });
        const parsed = path.parse(resolved);
        const stagedName = `${parsed.name}-${Date.now()}${parsed.ext || ''}`;
        const stagedPath = path.resolve(tmpRoot, stagedName);
        await fsPromises.copyFile(resolved, stagedPath);
        params.log.info(`[DingTalk] Staged file to workspace/tmp for reply: ${stagedPath}`);
        return stagedPath;
    } catch (error) {
        params.log.warn(`[DingTalk] Failed to stage file into workspace/tmp (${resolved}): ${String(error)}`);
        return null;
    }
}

async function collectReplyFiles(params: {
    responseText: string;
    workspaceRoot: string;
    log: Logger;
}): Promise<{ cleanedText: string; files: string[] }> {
    const extracted = collectReplyPathHints(params.responseText);
    return resolveExistingReplyFiles({
        candidates: extracted.candidates,
        workspaceRoot: params.workspaceRoot,
        log: params.log,
        cleanedText: extracted.cleanedText,
    });
}

async function resolveExistingReplyFiles(params: {
    candidates: string[];
    workspaceRoot: string;
    log: Logger;
    cleanedText?: string;
}): Promise<{ cleanedText: string; files: string[] }> {
    const deduped = new Set<string>();
    const files: string[] = [];

    for (const candidate of params.candidates) {
        const resolved = resolvePathInWorkspace(candidate, params.workspaceRoot);
        if (!resolved || deduped.has(resolved)) {
            continue;
        }
        deduped.add(resolved);

        try {
            const stat = await fsPromises.stat(resolved);
            if (!stat.isFile()) {
                continue;
            }
            if (stat.size <= 0) {
                continue;
            }
            if (stat.size > MAX_REPLY_FILE_BYTES) {
                params.log.warn(
                    `[DingTalk] Skip file return (>10MB): ${resolved} (${formatBytes(stat.size)})`
                );
                continue;
            }
            const staged = await ensureReplyFileUnderTmp({
                filePath: resolved,
                workspaceRoot: params.workspaceRoot,
                log: params.log,
            });
            if (!staged) {
                continue;
            }
            files.push(staged);
            if (files.length >= MAX_REPLY_FILES) {
                break;
            }
        } catch {
            continue;
        }
    }

    return {
        cleanedText: params.cleanedText || '',
        files,
    };
}

async function collectRequestedFilesFromUser(params: {
    userText: string;
    workspaceRoot: string;
    log: Logger;
}): Promise<string[]> {
    if (!USER_FILE_TRANSFER_INTENT_PATTERN.test(params.userText)) {
        return [];
    }
    const candidates = collectWorkspacePathHints(params.userText);
    if (candidates.length === 0) {
        return [];
    }
    const resolved = await resolveExistingReplyFiles({
        candidates,
        workspaceRoot: params.workspaceRoot,
        log: params.log,
    });
    return resolved.files;
}

function mergeFilePaths(paths: string[]): string[] {
    const deduped = new Set<string>();
    for (const item of paths) {
        if (!item) continue;
        deduped.add(item);
        if (deduped.size >= MAX_REPLY_FILES) break;
    }
    return Array.from(deduped);
}

async function sendReplyFiles(params: {
    dingtalkConfig: DingTalkConfig;
    conversationId: string;
    senderId: string;
    isDirect: boolean;
    sessionWebhook: string;
    filePaths: string[];
    log: Logger;
}): Promise<void> {
    if (params.filePaths.length === 0) return;

    const target = params.isDirect ? params.senderId : params.conversationId;
    const failed: string[] = [];

    for (const filePath of params.filePaths) {
        try {
            await sendProactiveFile(params.dingtalkConfig, target, filePath, params.log);
        } catch (error) {
            params.log.warn(`[DingTalk] Failed to send file ${filePath}: ${String(error)}`);
            failed.push(`${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (failed.length > 0) {
        await sendBySession(
            params.dingtalkConfig,
            params.sessionWebhook,
            `⚠️ 以下文件回传失败:\n${failed.join('\n')}`,
            { atUserId: !params.isDirect ? params.senderId : null },
            params.log
        );
    }
}

function looksLikeTextFile(filePath: string, mimeType: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (TEXT_FILE_EXTENSIONS.has(ext)) {
        return true;
    }
    return TEXT_MIME_HINTS.some((hint) => mimeType.startsWith(hint));
}

function looksBinary(buffer: Buffer): boolean {
    const sampleLength = Math.min(buffer.length, 4096);
    if (sampleLength === 0) return false;
    let suspicious = 0;

    for (let i = 0; i < sampleLength; i += 1) {
        const code = buffer[i];
        if (code === 0) {
            return true;
        }
        const isControl = code < 9 || (code > 13 && code < 32);
        if (isControl) {
            suspicious += 1;
        }
    }
    return suspicious / sampleLength > 0.15;
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean }> {
    const handle = await fsPromises.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        const readSize = Math.min(stat.size, maxBytes);
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
        return {
            buffer: buffer.subarray(0, bytesRead),
            truncated: stat.size > maxBytes,
        };
    } finally {
        await handle.close();
    }
}

async function checkCommandAvailable(command: string): Promise<boolean> {
    const cached = commandAvailabilityCache.get(command);
    if (cached !== undefined) {
        return cached;
    }

    let available = false;
    try {
        await execFileAsync(command, ['-version'], { timeout: 2000 });
        available = true;
    } catch {
        available = false;
    }
    commandAvailabilityCache.set(command, available);
    return available;
}

async function describeImagesWithModel(params: {
    config: Config;
    log: Logger;
    prompt: string;
    images: Array<{ imagePath: string; mimeType: string }>;
}): Promise<string | null> {
    const imageBlocks: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
        { type: 'text', text: params.prompt },
    ];

    for (const image of params.images) {
        let imageBuffer: Buffer;
        try {
            imageBuffer = await fsPromises.readFile(image.imagePath);
        } catch (error) {
            params.log.warn(`[DingTalk] Failed to read image file ${image.imagePath}: ${String(error)}`);
            continue;
        }

        if (imageBuffer.length > MAX_IMAGE_BYTES) {
            params.log.warn(
                `[DingTalk] Skip image understanding for large image (${formatBytes(imageBuffer.length)}): ${image.imagePath}`
            );
            continue;
        }

        imageBlocks.push({
            type: 'image_url',
            image_url: {
                url: `data:${normalizeMimeType(image.mimeType)};base64,${imageBuffer.toString('base64')}`,
            },
        });
    }

    if (imageBlocks.length <= 1) {
        return null;
    }

    try {
        const model = await createChatModel(params.config, { temperature: 0 });
        const result = await model.invoke([new LCHumanMessage({ content: imageBlocks })]);
        const text = extractTextFromModelContent(result.content);
        return text || null;
    } catch (error) {
        params.log.warn(`[DingTalk] Media understanding failed: ${String(error)}`);
        return null;
    }
}

async function probeVideoDuration(filePath: string): Promise<number | null> {
    if (!(await checkCommandAvailable('ffprobe'))) {
        return null;
    }
    try {
        const { stdout } = await execFileAsync(
            'ffprobe',
            [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                filePath,
            ],
            { timeout: 8000 }
        );
        const value = Number.parseFloat(stdout.trim());
        if (Number.isFinite(value) && value > 0) {
            return value;
        }
    } catch {
        // ignore probe failures
    }
    return null;
}

function buildVideoTimestamps(duration: number | null): number[] {
    if (!duration || duration <= 0) {
        return [1];
    }
    if (duration < 5) {
        return [Math.max(duration / 2, 0.5)];
    }

    const raw = [duration * 0.15, duration * 0.5, duration * 0.85];
    const deduped = new Set<string>();
    const result: number[] = [];
    for (const value of raw) {
        const normalized = Math.max(0.5, Math.min(duration - 0.5, value));
        const key = normalized.toFixed(2);
        if (deduped.has(key)) continue;
        deduped.add(key);
        result.push(normalized);
        if (result.length >= MAX_VIDEO_FRAMES) break;
    }
    return result.length > 0 ? result : [1];
}

async function extractVideoFrames(params: {
    videoPath: string;
    duration: number | null;
    log: Logger;
}): Promise<{ tempDir: string; framePaths: string[] } | null> {
    if (!(await checkCommandAvailable('ffmpeg'))) {
        return null;
    }

    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'dingtalk-video-'));
    const framePaths: string[] = [];
    const timestamps = buildVideoTimestamps(params.duration);

    for (let i = 0; i < timestamps.length; i += 1) {
        const timestamp = timestamps[i];
        const framePath = path.join(tempDir, `frame_${i + 1}.jpg`);
        try {
            await execFileAsync(
                'ffmpeg',
                [
                    '-hide_banner',
                    '-loglevel', 'error',
                    '-ss', timestamp.toFixed(2),
                    '-i', params.videoPath,
                    '-frames:v', '1',
                    '-q:v', '3',
                    '-y',
                    framePath,
                ],
                { timeout: 15000 }
            );
            const stat = await fsPromises.stat(framePath);
            if (stat.size > 0) {
                framePaths.push(framePath);
            }
        } catch (error) {
            params.log.debug(`[DingTalk] Failed to extract video frame at ${timestamp.toFixed(2)}s: ${String(error)}`);
        }
    }

    if (framePaths.length === 0) {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
        return null;
    }

    return { tempDir, framePaths };
}

async function buildMediaContext(params: {
    config: Config;
    content: MessageContent;
    mediaPath: string;
    mimeType: string;
    log: Logger;
}): Promise<string | null> {
    const mediaType = params.content.mediaType;
    if (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'file') {
        return null;
    }

    let statSize = 0;
    try {
        const stat = await fsPromises.stat(params.mediaPath);
        statSize = stat.size;
    } catch {
        return null;
    }

    const mimeType = normalizeMimeType(params.mimeType);
    const fileName = path.basename(params.mediaPath);
    const baseLines = [
        '[媒体上下文]',
        `类型: ${mediaType}`,
        `文件: ${fileName}`,
        `MIME: ${mimeType}`,
        `大小: ${formatBytes(statSize)}`,
        `本地路径: ${params.mediaPath}`,
    ];

    if (mediaType === 'image') {
        const description = await describeImagesWithModel({
            config: params.config,
            log: params.log,
            prompt:
                '你是媒体解析器。请用中文简洁输出：1) 场景与主体 2) 关键文字/OCR 3) 与用户问题可能相关的信息。不要编造。',
            images: [{ imagePath: params.mediaPath, mimeType }],
        });
        baseLines.push(description ? `图片理解:\n${description}` : '图片理解: 无法自动解析，请结合路径自行处理。');
        return baseLines.join('\n');
    }

    if (mediaType === 'file') {
        if (!looksLikeTextFile(params.mediaPath, mimeType)) {
            baseLines.push('文件解析: 该文件不是可直接读取的文本格式，已保留元信息。');
            return baseLines.join('\n');
        }

        try {
            const { buffer, truncated } = await readFilePrefix(params.mediaPath, MAX_TEXT_FILE_BYTES);
            if (looksBinary(buffer)) {
                baseLines.push('文件解析: 文件包含二进制内容，无法作为纯文本读取。');
                return baseLines.join('\n');
            }
            const raw = buffer.toString('utf-8').replace(/\u0000/g, '').trim();
            const snippet = raw.length > MAX_TEXT_FILE_CHARS ? `${raw.slice(0, MAX_TEXT_FILE_CHARS)}\n...(truncated)` : raw;
            const truncatedFlag = truncated || raw.length > MAX_TEXT_FILE_CHARS;
            const safeSnippet = snippet.replace(/<\/file>/gi, '</ file>');
            baseLines.push(`<file name="${fileName}" mime="${mimeType}" truncated="${truncatedFlag}">\n${safeSnippet}\n</file>`);
            return baseLines.join('\n');
        } catch (error) {
            params.log.warn(`[DingTalk] Failed to parse file ${params.mediaPath}: ${String(error)}`);
            baseLines.push('文件解析: 读取失败，已保留元信息。');
            return baseLines.join('\n');
        }
    }

    const duration = await probeVideoDuration(params.mediaPath);
    if (duration) {
        baseLines.push(`时长: ${duration.toFixed(1)}s`);
    }

    let extracted: { tempDir: string; framePaths: string[] } | null = null;
    try {
        extracted = await extractVideoFrames({
            videoPath: params.mediaPath,
            duration,
            log: params.log,
        });

        if (!extracted) {
            baseLines.push('视频理解: 当前环境未提供 ffmpeg/ffprobe 或抽帧失败，已保留元信息。');
            return baseLines.join('\n');
        }

        const description = await describeImagesWithModel({
            config: params.config,
            log: params.log,
            prompt: '你会收到同一段视频的多帧截图。请用中文输出视频内容摘要、关键动作和明显文字信息。不要编造。',
            images: extracted.framePaths.map((framePath) => ({
                imagePath: framePath,
                mimeType: 'image/jpeg',
            })),
        });

        baseLines.push(`抽帧: ${extracted.framePaths.length} 帧`);
        baseLines.push(description ? `视频理解:\n${description}` : '视频理解: 抽帧成功，但模型未返回有效描述。');
        return baseLines.join('\n');
    } finally {
        if (extracted) {
            await fsPromises.rm(extracted.tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

export interface MessageHandlerContext {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: any;
    config: Config;
    dingtalkConfig: DingTalkConfig;
    log: Logger;
    switchModel?: (alias: string) => Promise<{ alias: string; model: string }>;
}

type ModelSlashCommand = { type: 'list' } | { type: 'switch'; alias: string };

type VoiceSlashCommand =
    | { type: 'voice'; mode: 'status' }
    | { type: 'voice'; mode: 'toggle'; enabled: boolean };

type HelpSlashCommand = { type: 'help' };
type UnknownSlashCommand = { type: 'unknown'; command: string };
type SlashCommand = ModelSlashCommand | { type: 'status' } | VoiceSlashCommand | HelpSlashCommand | UnknownSlashCommand;

interface VoiceInputConfig {
    enabled: boolean;
    requireRecognition: boolean;
    prependRecognitionHint: boolean;
}

function resolveVoiceInputConfig(config: DingTalkConfig): VoiceInputConfig {
    const voice = config.voice;
    return {
        enabled: voice?.enabled ?? true,
        requireRecognition: voice?.requireRecognition ?? true,
        prependRecognitionHint: voice?.prependRecognitionHint ?? true,
    };
}

function parseSlashCommand(input: string): SlashCommand | null {
    const text = input.trim();
    if (!text.startsWith('/')) {
        return null;
    }
    if (text === '/models') {
        return { type: 'list' };
    }
    if (text === '/status') {
        return { type: 'status' };
    }
    if (text === '/model') {
        return { type: 'switch', alias: '' };
    }
    if (text.startsWith('/model ')) {
        return { type: 'switch', alias: text.slice('/model'.length).trim() };
    }
    if (text === '/voice') {
        return { type: 'voice', mode: 'status' };
    }
    if (text.startsWith('/voice ')) {
        const arg = text.slice('/voice'.length).trim().toLowerCase();
        if (arg === 'on') {
            return { type: 'voice', mode: 'toggle', enabled: true };
        }
        if (arg === 'off') {
            return { type: 'voice', mode: 'toggle', enabled: false };
        }
        return { type: 'voice', mode: 'status' };
    }
    if (text === '/help' || text === '/?') {
        return { type: 'help' };
    }
    const command = text.split(/\s+/, 1)[0] || text;
    return { type: 'unknown', command };
}

function maskApiKey(apiKey: string): string {
    if (!apiKey) return '(not set)';
    if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}...${apiKey.slice(-2)}`;
    return `${apiKey.slice(0, 6)}...${apiKey.slice(-6)}`;
}

function formatRelativeTime(updatedAt: number): string {
    const diffMs = Math.max(0, Date.now() - updatedAt);
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 5) return '刚刚';
    if (diffSec < 60) return `${diffSec} 秒前`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    return `${Math.floor(diffSec / 86400)} 天前`;
}

function buildHelpMessage(currentModelAlias: string): string {
    return [
        '## 命令帮助',
        '',
        '- `/status` 查看当前会话状态',
        '- `/models` 查看可用模型列表',
        '- `/model <别名>` 切换模型（例如 `/model qwen`）',
        '- `/voice` 查看语音输入开关状态',
        '- `/voice on` / `/voice off` 开关语音输入',
        '- `/help` 或 `/?` 查看本帮助',
        '',
        `当前模型：\`${currentModelAlias}\``,
    ].join('\n');
}

function buildStatusMessage(params: {
    config: Config;
    session: SessionState;
}): string {
    const { config, session } = params;
    const activeAlias = getActiveModelAlias(config);
    const activeModel = getActiveModelEntry(config);
    const contextConfig = config.agent.compaction;
    const appVersion = process.env.npm_package_version || '1.0.0';
    const contextRatio = (session.totalTokens / contextConfig.context_window) * 100;
    const contextPercent = contextRatio >= 1
        ? Math.round(contextRatio)
        : Number(contextRatio.toFixed(1));

    const modelLabel = `${activeModel.provider}/${activeModel.model}`;
    const providerAlias = `${activeModel.provider}:${activeAlias}`;
    return [
        `## SRE Bot ${appVersion} 状态`,
        '',
        `- 模型：\`${modelLabel}\``,
        `- 别名：\`${providerAlias}\``,
        `- API Key：\`${maskApiKey(activeModel.api_key)}\``,
        `- Token：输入 ${formatTokenCount(session.totalInputTokens)} / 输出 ${formatTokenCount(session.totalOutputTokens)}`,
        `- 上下文：${formatTokenCount(session.totalTokens)} / ${formatTokenCount(contextConfig.context_window)}（${contextPercent}%）`,
        `- 压缩次数：${session.compactionCount}`,
        `- 会话：\`${session.threadId}\``,
        `- 最近更新：${formatRelativeTime(session.lastUpdated)}`,
        `- 运行模式：dingtalk（think=low，queue=collect depth=0）`,
        '',
        getContextUsageInfo(session.totalTokens, contextConfig),
        `自动压缩阈值：${formatTokenCount(contextConfig.auto_compact_threshold)}`,
    ].join('\n');
}

async function tryHandleSlashCommand(params: {
    text: string;
    ctx: MessageHandlerContext;
    session: SessionState;
    sessionWebhook: string;
    isDirect: boolean;
    senderId: string;
}): Promise<boolean> {
    const parsed = parseSlashCommand(params.text);
    if (!parsed) return false;

    const mention = { atUserId: !params.isDirect ? params.senderId : null };
    if (parsed.type === 'status') {
        const message = buildStatusMessage({
            config: params.ctx.config,
            session: params.session,
        });
        await sendBySession(params.ctx.dingtalkConfig, params.sessionWebhook, message, mention, params.ctx.log);
        return true;
    }

    if (parsed.type === 'voice') {
        const voiceConfig = resolveVoiceInputConfig(params.ctx.dingtalkConfig);
        if (parsed.mode === 'toggle') {
            params.ctx.dingtalkConfig.voice = {
                ...(params.ctx.dingtalkConfig.voice || {}),
                enabled: parsed.enabled,
            };
        }
        const current = resolveVoiceInputConfig(params.ctx.dingtalkConfig);
        const text = parsed.mode === 'toggle'
            ? `✅ 语音输入已${parsed.enabled ? '开启' : '关闭'}。\n` +
            `识别文本必需: ${current.requireRecognition ? '是' : '否'}\n` +
            `转写提示前缀: ${current.prependRecognitionHint ? '开启' : '关闭'}\n` +
            '提示: /voice on 或 /voice off 可实时切换'
            : `🎤 语音输入状态: ${voiceConfig.enabled ? '开启' : '关闭'}\n` +
            `识别文本必需: ${voiceConfig.requireRecognition ? '是' : '否'}\n` +
            `转写提示前缀: ${voiceConfig.prependRecognitionHint ? '开启' : '关闭'}\n` +
            '提示: /voice on 或 /voice off 可实时切换';
        await sendBySession(params.ctx.dingtalkConfig, params.sessionWebhook, text, mention, params.ctx.log);
        return true;
    }

    if (parsed.type === 'list') {
        const activeAlias = getActiveModelAlias(params.ctx.config);
        const lines = listConfiguredModels(params.ctx.config)
            .map((item) => `- ${item.alias === activeAlias ? '✅' : '▫️'} \`${item.alias}\` (${item.provider}) → ${item.model}`)
            .join('\n');
        const message = lines
            ? `## 已配置模型\n\n${lines}\n\n当前模型：\`${activeAlias}\``
            : '## 已配置模型\n\n当前没有可用模型配置。';
        await sendBySession(params.ctx.dingtalkConfig, params.sessionWebhook, message, mention, params.ctx.log);
        return true;
    }

    if (parsed.type === 'help') {
        const message = buildHelpMessage(getActiveModelAlias(params.ctx.config));
        await sendBySession(params.ctx.dingtalkConfig, params.sessionWebhook, message, mention, params.ctx.log);
        return true;
    }

    if (parsed.type === 'unknown') {
        const message = `❓ 未知命令：\`${parsed.command}\`\n\n发送 \`/help\` 查看可用命令。`;
        await sendBySession(params.ctx.dingtalkConfig, params.sessionWebhook, message, mention, params.ctx.log);
        return true;
    }

    if (!parsed.alias) {
        await sendBySession(
            params.ctx.dingtalkConfig,
            params.sessionWebhook,
            `ℹ️ 用法: /model <模型别名>\n当前模型: ${getActiveModelAlias(params.ctx.config)}`,
            mention,
            params.ctx.log
        );
        return true;
    }

    if (!params.ctx.switchModel) {
        await sendBySession(
            params.ctx.dingtalkConfig,
            params.sessionWebhook,
            '❌ 当前运行模式不支持实时切换模型。',
            mention,
            params.ctx.log
        );
        return true;
    }

    try {
        const result = await params.ctx.switchModel(parsed.alias);
        await sendBySession(
            params.ctx.dingtalkConfig,
            params.sessionWebhook,
            `✅ 已切换模型: ${result.alias} (${result.model})`,
            mention,
            params.ctx.log
        );
    } catch (error) {
        await sendBySession(
            params.ctx.dingtalkConfig,
            params.sessionWebhook,
            `❌ 切换模型失败: ${error instanceof Error ? error.message : String(error)}`,
            mention,
            params.ctx.log
        );
    }
    return true;
}

function preprocessAudioMessage(params: {
    config: DingTalkConfig;
    data: DingTalkInboundMessage;
    content: MessageContent;
}): { ok: true } | { ok: false; reason: string } {
    if (params.content.messageType !== 'audio') {
        return { ok: true };
    }

    const voiceConfig = resolveVoiceInputConfig(params.config);
    if (!voiceConfig.enabled) {
        return {
            ok: false,
            reason: '🎤 当前会话未开启语音输入，发送 `/voice on` 后再试。',
        };
    }

    const recognized = (params.data.content?.recognition || '').trim();
    if (!recognized) {
        if (voiceConfig.requireRecognition) {
            return {
                ok: false,
                reason: '❌ 未获取到语音识别文本。请在钉钉侧开启语音转文字，或直接发送文字消息。',
            };
        }
        params.content.text = '[语音消息]';
        return { ok: true };
    }

    const normalized = recognized.replace(/\s+/g, ' ').trim();
    params.content.text = voiceConfig.prependRecognitionHint
        ? `【用户语音转写】${normalized}`
        : normalized;

    return { ok: true };
}

/**
 * Handle incoming DingTalk message
 */
export async function handleMessage(
    data: DingTalkInboundMessage,
    ctx: MessageHandlerContext
): Promise<void> {
    const senderId = data.senderStaffId || data.senderId;
    const senderName = data.senderNick || 'Unknown';
    const isDirect = data.conversationType === '1';
    return enqueueConversationTask(data.conversationId, () =>
        withDingTalkConversationContext(
            {
                conversationId: data.conversationId,
                isDirect,
                senderId,
                senderName,
                sessionWebhook: data.sessionWebhook,
                workspaceRoot: path.resolve(process.cwd(), ctx.config.agent.workspace),
                pendingReplyFiles: [],
            },
            () => handleMessageInternal(data, ctx)
        )
    );
}

async function handleMessageInternal(
    data: DingTalkInboundMessage,
    ctx: MessageHandlerContext
): Promise<void> {
    const { config, dingtalkConfig, log } = ctx;
    const persistedSessionStore = await getSessionStore(config, log);

    // Clean up expired sessions periodically
    await cleanupSessions(persistedSessionStore, log);
    cleanupCardCache();

    // Ignore bot self-messages
    if (data.senderId === data.chatbotUserId || data.senderStaffId === data.chatbotUserId) {
        log.debug('[DingTalk] Ignoring robot self-message');
        return;
    }

    // Extract message content
    const content = extractMessageContent(data);
    if (!content.text) {
        log.debug('[DingTalk] Empty message content, ignoring');
        return;
    }

    const isDirect = data.conversationType === '1';
    const senderId = data.senderStaffId || data.senderId;
    const senderName = data.senderNick || 'Unknown';
    const conversationId = data.conversationId;
    const scope = resolveMemoryScope(config.agent.memory.session_isolation);

    // Get or create session for this conversation
    const session = await getOrCreateSession({
        sessionKey: scope.key,
        scopeKey: scope.key,
        store: persistedSessionStore,
        log,
    });

    const handledModelCommand = await tryHandleSlashCommand({
        text: content.text,
        ctx,
        session,
        sessionWebhook: data.sessionWebhook,
        isDirect,
        senderId,
    });
    if (handledModelCommand) {
        return;
    }

    const audioPreprocess = preprocessAudioMessage({
        config: dingtalkConfig,
        data,
        content,
    });
    if (!audioPreprocess.ok) {
        await sendBySession(
            dingtalkConfig,
            data.sessionWebhook,
            audioPreprocess.reason,
            { atUserId: !isDirect ? senderId : null },
            log
        );
        return;
    }

    let downloadedMediaPath: string | undefined;
    if (content.mediaPath && dingtalkConfig.robotCode) {
        const media = await downloadMedia(dingtalkConfig, content.mediaPath, log);
        if (media) {
            downloadedMediaPath = media.path;
            const mediaNote = `[媒体文件已下载: ${media.path} (${media.mimeType})]`;
            const mediaContext = await buildMediaContext({
                config,
                content,
                mediaPath: media.path,
                mimeType: media.mimeType,
                log,
            });
            const appendix = mediaContext ? `${mediaNote}\n${mediaContext}` : mediaNote;
            content.text = content.text ? `${content.text}\n\n${appendix}` : appendix;
        }
    }

    // Handle exec approval replies before normal processing
    const approvalHandled = await tryHandleExecApprovalReply({
        text: content.text,
        conversationId,
        senderId,
        sessionWebhook: data.sessionWebhook,
        isDirect,
        dingtalkConfig,
        log,
    });
    if (approvalHandled) {
        return;
    }

    // If there is a pending approval in this conversation, block new requests.
    if (hasPendingApprovalForKey(conversationId, senderId)) {
        await sendBySession(
            dingtalkConfig,
            data.sessionWebhook,
            '⏳ 当前有待处理的审批，请先完成审批后再发送新请求。',
            { atUserId: !isDirect ? senderId : null },
            log
        );
        return;
    }

    log.info(`[DingTalk] Received message from ${senderName}: "${content.text.slice(0, 50)}${content.text.length > 50 ? '...' : ''}"`);

    // Create flush state from session
    let flushState: MemoryFlushState = createMemoryFlushState();
    flushState = { ...flushState, totalTokens: session.totalTokens };

    // Update token count with user input
    flushState = updateTokenCount(flushState, content.text);
    session.totalInputTokens += estimateTokens(content.text);
    const memoryWorkspacePath = path.resolve(process.cwd(), config.agent.workspace);
    await persistSessionEvent({
        role: 'user',
        content: content.text,
        conversationId,
        sessionKey: scope.key,
        store: persistedSessionStore,
        workspacePath: memoryWorkspacePath,
        config,
        log,
    });

    // Reuse shared compaction model
    const compactionModel = await getCompactionModel(config);
    const compactionConfig = config.agent.compaction;

    // Check if we need auto-compaction before processing
    flushState = await executeAutoCompact(
        ctx.agent,
        session,
        flushState,
        compactionModel,
        compactionConfig,
        log,
        {
            store: persistedSessionStore,
            sessionKey: scope.key,
            conversationId,
            workspacePath: memoryWorkspacePath,
            config,
        }
    );
    session.totalTokens = flushState.totalTokens;

    // Determine message mode
    const useCardMode = dingtalkConfig.messageType === 'card';
    let currentCard: AICardInstance | null = null;

    // Create or reuse AI Card if in card mode
    if (useCardMode) {
        const targetKey = isDirect ? senderId : conversationId;
        currentCard = getActiveAICard(targetKey) || null;
        if (currentCard) {
            log.info('[DingTalk] Reusing active AI Card for this conversation...');
        } else {
            log.info('[DingTalk] Card mode enabled, creating AI Card...');
            currentCard = await createAICard(
                dingtalkConfig,
                conversationId,
                isDirect,
                senderId,
                log
            );
            if (!currentCard) {
                log.warn('[DingTalk] Failed to create AI Card, falling back to markdown mode');
            } else {
                log.info('[DingTalk] AI Card created, proceeding with streaming...');
            }
        }
    }

    // Send "thinking" feedback (only for markdown mode, card mode shows thinking state visually)
    if (!currentCard && dingtalkConfig.showThinking !== false) {
        try {
            await sendBySession(
                dingtalkConfig,
                data.sessionWebhook,
                '🤔 思考中，请稍候...',
                { atUserId: !isDirect ? senderId : null },
                log
            );
        } catch (err) {
            log.debug('[DingTalk] Failed to send thinking message:', String(err));
        }
    }

    try {
        // Invoke agent with streaming for card mode
        const enforceMemorySearch = hasMemoryRecallIntent(content.text);
        if (enforceMemorySearch) {
            log.info('[DingTalk] Memory recall intent detected, enforce memory_search preflight');
        }
        const shouldInjectStartupMemory = !hydratedThreadIds.has(session.threadId) && session.messageHistory.length === 0;
        const startupMemoryInjection = shouldInjectStartupMemory
            ? await buildSessionStartupMemoryInjection({
                workspacePath: memoryWorkspacePath,
                scopeKey: scope.key,
            })
            : null;
        if (startupMemoryInjection) {
            log.info(`[DingTalk] Startup memory injection enabled for ${session.threadId}, chars=${startupMemoryInjection.length}`);
        }
        const invocationMessages = buildAgentInvocationMessages(session, content.text, {
            enforceMemorySearch,
            startupMemoryInjection,
        });
        const agentConfig = {
            configurable: { thread_id: session.threadId },
            recursionLimit: config.agent.recursion_limit,
        };

        log.debug(`[DingTalk] Invoking agent with thread_id: ${session.threadId}`);

        let fullResponse = '';
        let rawStreamResponse = '';
        let finalOutputFromEvents = '';
        let lastToolOutputFromEvents = '';
        let sawToolCall = false;
        let responseFiles: string[] = [];
        const workspaceRoot = memoryWorkspacePath;
        const requestedFilesFromUser = await collectRequestedFilesFromUser({
            userText: content.text,
            workspaceRoot,
            log,
        });
        if (requestedFilesFromUser.length > 0) {
            log.info(`[DingTalk] User requested file return, matched files: ${requestedFilesFromUser.join(', ')}`);
        }

        if (currentCard) {
            // Card mode: use streaming
            log.info('[DingTalk] Starting streamEvents...');

            const eventStream = ctx.agent.streamEvents(
                { messages: invocationMessages },
                { ...agentConfig, version: 'v2' }
            );

            log.info('[DingTalk] EventStream created, waiting for events...');

            let lastStreamTime = Date.now();
            const STREAM_THROTTLE = 500; // Minimum ms between stream updates
            const STREAM_MIN_CHARS = 40; // Minimum chars between updates
            let eventCount = 0;
            let lastFlushedLength = 0;
            let pendingFlush: NodeJS.Timeout | null = null;
            let flushInFlight = false;
            let flushQueuedFinal = false;
            let streamFlushError: unknown = null;

            const markStreamError = (err: unknown) => {
                if (!streamFlushError) {
                    streamFlushError = err;
                }
            };

            const flushNow = async (final: boolean) => {
                if (flushInFlight || !currentCard) {
                    flushQueuedFinal = flushQueuedFinal || final;
                    return;
                }
                const currentLength = fullResponse.length;
                if (!final && currentLength - lastFlushedLength < STREAM_MIN_CHARS) {
                    return;
                }
                flushInFlight = true;
                try {
                    await streamAICard(currentCard, fullResponse, final, dingtalkConfig, log);
                    lastStreamTime = Date.now();
                    lastFlushedLength = fullResponse.length;
                } catch (streamErr) {
                    markStreamError(streamErr);
                    log.warn('[DingTalk] Card stream update failed:', String(streamErr));
                } finally {
                    flushInFlight = false;
                    if (flushQueuedFinal) {
                        flushQueuedFinal = false;
                        await flushNow(true);
                    }
                }
            };

            const scheduleFlush = (final: boolean = false) => {
                if (final) flushQueuedFinal = true;
                if (pendingFlush) return;
                const now = Date.now();
                const delay = Math.max(0, STREAM_THROTTLE - (now - lastStreamTime));
                pendingFlush = setTimeout(() => {
                    pendingFlush = null;
                    void flushNow(final);
                }, delay);
            };

            const waitForStreamDrain = async (timeoutMs: number) => {
                const start = Date.now();
                while (Date.now() - start < timeoutMs) {
                    if (!flushInFlight && !pendingFlush && !flushQueuedFinal) {
                        return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
            };

            for await (const event of eventStream) {
                eventCount++;
                if (eventCount <= 3 || eventCount % 10 === 0) {
                    log.debug(`[DingTalk] Event #${eventCount}: ${event.event}`);
                }

                if (event.event === 'on_chat_model_stream') {
                    const chunk = event.data?.chunk;
                    if (chunk?.content) {
                        let text = '';
                        if (typeof chunk.content === 'string') {
                            text = chunk.content;
                        } else if (Array.isArray(chunk.content)) {
                            for (const item of chunk.content) {
                                if (item.type === 'text' && item.text) {
                                    text += item.text;
                                }
                            }
                        }

                        rawStreamResponse += text;
                        const cleanedCandidate = sanitizeAssistantReplyText(rawStreamResponse);
                        const shouldSuppressStreamCandidate = sawToolCall && (
                            isLikelyToolCallResidue(cleanedCandidate) || isLikelyStructuredToolPayload(cleanedCandidate)
                        );
                        if (!shouldSuppressStreamCandidate) {
                            fullResponse = cleanedCandidate;
                        }

                        // Throttle stream updates to avoid rate limiting
                        scheduleFlush(false);
                    }
                } else if (event.event === 'on_tool_start') {
                    const toolName = event.name;
                    sawToolCall = true;
                    log.info(`[DingTalk] Tool started: ${toolName}`);
                } else if (event.event === 'on_tool_end') {
                    const toolOutput = sanitizeAssistantReplyText(extractReplyTextFromEventData(event.data));
                    if (toolOutput) {
                        lastToolOutputFromEvents = toolOutput;
                    }
                } else if (event.event === 'on_chat_model_end' || event.event === 'on_chain_end') {
                    const extracted = sanitizeAssistantReplyText(extractReplyTextFromEventData(event.data));
                    if (extracted && !isLikelyToolCallResidue(extracted) && !isLikelyStructuredToolPayload(extracted)) {
                        finalOutputFromEvents = extracted;
                    }
                    const eventData = event.data as { output?: { messages?: unknown[] }; messages?: unknown[] } | undefined;
                    const outputMessages = Array.isArray(eventData?.output?.messages)
                        ? eventData.output.messages
                        : Array.isArray(eventData?.messages)
                            ? eventData.messages
                            : null;
                    if (outputMessages) {
                        const bestFromMessages = extractBestReadableReplyFromMessages(outputMessages);
                        if (bestFromMessages) {
                            finalOutputFromEvents = bestFromMessages;
                        }
                    }
                }
            }

            fullResponse = pickBestUserFacingResponse([
                finalOutputFromEvents,
                fullResponse,
                rawStreamResponse,
            ], {
                sawToolCall,
            });
            if (!fullResponse) {
                log.warn(
                    `[DingTalk] Stream reply did not produce user-facing text. ` +
                    `tool_called=${sawToolCall} raw_len=${rawStreamResponse.length} ` +
                    `chain_len=${finalOutputFromEvents.length} tool_len=${lastToolOutputFromEvents.length}`
                );
                if (sawToolCall) {
                    fullResponse = '我已完成工具查询，但结果整理失败。请让我重试一次，我会给你结构化结论。';
                }
            }

            log.info(`[DingTalk] Stream completed, total events: ${eventCount}, response length: ${fullResponse.length}`);
            const extractedReply = await collectReplyFiles({
                responseText: fullResponse,
                workspaceRoot,
                log,
            });
            fullResponse = extractedReply.cleanedText;
            responseFiles = extractedReply.files;
            const queuedToolFiles = await resolveExistingReplyFiles({
                candidates: consumeQueuedDingTalkReplyFiles(),
                workspaceRoot,
                log,
                cleanedText: fullResponse,
            });
            responseFiles = mergeFilePaths([...responseFiles, ...queuedToolFiles.files]);
            if (!fullResponse && responseFiles.length > 0) {
                fullResponse = '✅ 文件已生成并回传，请查收附件。';
            }

            // Finalize card
            let shouldFallbackToSessionMessage = false;
            if (fullResponse) {
                log.info('[DingTalk] Finalizing AI Card...');
                if (pendingFlush) {
                    clearTimeout(pendingFlush);
                    pendingFlush = null;
                }
                await flushNow(true);
                await waitForStreamDrain(2500);

                const cardState = currentCard.state as AICardState;
                if (streamFlushError || cardState === AICardStatus.FAILED) {
                    shouldFallbackToSessionMessage = true;
                    log.warn(
                        `[DingTalk] Card finalization incomplete (state=${cardState}), falling back to session markdown reply`
                    );
                } else if (cardState !== AICardStatus.FINISHED) {
                    log.warn(
                        `[DingTalk] Card finalization state still ${cardState}; skip markdown fallback to avoid duplicate reply`
                    );
                } else {
                    log.info('[DingTalk] AI Card finalized successfully');
                }
            } else {
                log.warn('[DingTalk] No response content to send');
                fullResponse = '抱歉，我暂时没有生成有效回复，请稍后重试。';
                shouldFallbackToSessionMessage = true;
            }

            if (shouldFallbackToSessionMessage) {
                await sendBySession(
                    dingtalkConfig,
                    data.sessionWebhook,
                    fullResponse,
                    {
                        useMarkdown: true,
                        atUserId: !isDirect ? senderId : null,
                    },
                    log
                );
            }
        } else {
            // Markdown mode: use invoke
            const result = await ctx.agent.invoke(
                { messages: invocationMessages },
                agentConfig
            );

            // Extract response
            const messages = result.messages;
            if (Array.isArray(messages) && messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                fullResponse = typeof lastMessage.content === 'string'
                    ? lastMessage.content
                    : JSON.stringify(lastMessage.content);
            }
            fullResponse = pickBestUserFacingResponse([
                fullResponse,
                Array.isArray(messages) ? extractBestReadableReplyFromMessages(messages) : '',
            ]);

            if (!fullResponse) {
                fullResponse = '抱歉，我没有生成有效的回复。';
            }
            const extractedReply = await collectReplyFiles({
                responseText: fullResponse,
                workspaceRoot,
                log,
            });
            fullResponse = extractedReply.cleanedText;
            responseFiles = extractedReply.files;
            const queuedToolFiles = await resolveExistingReplyFiles({
                candidates: consumeQueuedDingTalkReplyFiles(),
                workspaceRoot,
                log,
                cleanedText: fullResponse,
            });
            responseFiles = mergeFilePaths([...responseFiles, ...queuedToolFiles.files]);
            if (!fullResponse && responseFiles.length > 0) {
                fullResponse = '✅ 文件已生成并回传，请查收附件。';
            }

            // Send response back to DingTalk
            log.info(`[DingTalk] Sending response (${fullResponse.length} chars) to ${senderName}`);

            await sendBySession(
                dingtalkConfig,
                data.sessionWebhook,
                fullResponse,
                {
                    useMarkdown: true,
                    atUserId: !isDirect ? senderId : null,
                },
                log
            );
        }

        await sendReplyFiles({
            dingtalkConfig,
            conversationId,
            senderId,
            isDirect,
            sessionWebhook: data.sessionWebhook,
            filePaths: mergeFilePaths([...requestedFilesFromUser, ...responseFiles]),
            log,
        });
        hydratedThreadIds.add(session.threadId);

        // Update token count and message history
        flushState = updateTokenCount(flushState, fullResponse);
        session.totalOutputTokens += estimateTokens(fullResponse);
        await persistSessionEvent({
            role: 'assistant',
            content: fullResponse,
            conversationId,
            sessionKey: scope.key,
            store: persistedSessionStore,
            workspacePath: memoryWorkspacePath,
            config,
            log,
        });
        const { HumanMessage, AIMessage } = await import('@langchain/core/messages');
        session.messageHistory.push(new HumanMessage(content.text));
        session.messageHistory.push(new AIMessage(fullResponse));
        session.totalTokens = flushState.totalTokens;
        session.lastUpdated = Date.now();

        // Check auto-compaction after response
        flushState = await executeAutoCompact(
            ctx.agent,
            session,
            flushState,
            compactionModel,
            compactionConfig,
            log,
            {
                store: persistedSessionStore,
                sessionKey: scope.key,
                conversationId,
                workspacePath: memoryWorkspacePath,
                config,
            }
        );
        session.totalTokens = flushState.totalTokens;
        await persistSession({
            sessionKey: scope.key,
            scopeKey: scope.key,
            session,
            store: persistedSessionStore,
            log,
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`[DingTalk] Error processing message: ${errorMessage}`);
        const err = error as {
            name?: string;
            code?: string;
            status?: number;
            response?: { status?: number; data?: unknown; config?: { url?: string; method?: string } };
            config?: { url?: string; method?: string };
            stack?: string;
        };
        const safeStringify = (value: unknown) => {
            try {
                return JSON.stringify(value);
            } catch {
                return '"[unserializable]"';
            }
        };
        const cause = (err as { cause?: unknown })?.cause;
        log.error(
            `[DingTalk] Error details: ${safeStringify({
                name: err?.name,
                code: err?.code,
                status: err?.status ?? err?.response?.status,
                url: err?.response?.config?.url || err?.config?.url,
                method: err?.response?.config?.method || err?.config?.method,
                data: err?.response?.data,
                cause: cause && typeof cause === 'object' ? cause : String(cause ?? ''),
                stack: err?.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : undefined,
            })}`
        );

        // If card mode failed, try to finalize with error
        if (currentCard && !isCardFinished(currentCard)) {
            try {
                await finishAICard(currentCard, `❌ 处理出错: ${errorMessage}`, dingtalkConfig, log);
            } catch (finishErr) {
                log.debug('[DingTalk] Failed to finalize error card:', String(finishErr));
            }
        }

        try {
            await sendBySession(
                dingtalkConfig,
                data.sessionWebhook,
                `❌ 处理消息时出错: ${errorMessage}`,
                { atUserId: !isDirect ? senderId : null },
                log
            );
        } catch (sendErr) {
            log.error('[DingTalk] Failed to send error message:', String(sendErr));
        }
    } finally {
        if (downloadedMediaPath) {
            try {
                await import('node:fs/promises').then((fsPromises) => fsPromises.unlink(downloadedMediaPath));
            } catch {
                // ignore cleanup errors
            }
        }
    }
}

/**
 * Execute memory flush
 */
async function executeMemoryFlush(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: any,
    session: SessionState,
    flushState: MemoryFlushState,
    log: Logger,
    options?: { preserveTokenCount?: boolean }
): Promise<MemoryFlushState> {
    log.info('[DingTalk] Executing memory flush...');
    const tokensBeforeFlush = flushState.totalTokens;

    try {
        const result = await agent.invoke(
            {
                messages: [
                    { role: 'user', content: buildMemoryFlushPrompt() },
                ],
            },
            {
                configurable: { thread_id: session.threadId },
                recursionLimit: 10,
            }
        );

        const messages = result.messages;
        if (Array.isArray(messages) && messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            const content = typeof lastMessage.content === 'string' ? lastMessage.content : '';
            if (isNoReplyResponse(content)) {
                log.debug('[DingTalk] Memory flush completed (no reply needed)');
            } else {
                log.debug('[DingTalk] Memory flush completed');
            }
        }

        const nextState = markFlushCompleted(flushState);
        if (options?.preserveTokenCount) {
            return {
                ...nextState,
                totalTokens: tokensBeforeFlush,
                lastFlushTokens: tokensBeforeFlush,
            };
        }
        return nextState;
    } catch (error) {
        log.error('[DingTalk] Memory flush failed:', String(error));
        return flushState;
    }
}

/**
 * Execute auto-compaction if needed
 */
async function executeAutoCompact(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: any,
    session: SessionState,
    flushState: MemoryFlushState,
    compactionModel: BaseChatModel,
    compactionConfig: CompactionConfig,
    log: Logger,
    options?: {
        store: DingTalkSessionStore | null;
        sessionKey: string;
        conversationId: string;
        workspacePath: string;
        config: Config;
    }
): Promise<MemoryFlushState> {
    const tokensBeforeAutoCompact = flushState.totalTokens;

    // First: flush memory to save important info
    if (shouldTriggerMemoryFlush(flushState, compactionConfig)) {
        flushState = await executeMemoryFlush(agent, session, flushState, log, { preserveTokenCount: true });
    }

    if (!shouldAutoCompact(tokensBeforeAutoCompact, compactionConfig)) {
        return flushState;
    }

    log.info('[DingTalk] Auto-compacting context...');

    // Then: compact context
    try {
        const maxTokens = Math.floor(compactionConfig.context_window * compactionConfig.max_history_share);
        const result = await compactMessages(session.messageHistory, compactionModel, maxTokens);

        session.messageHistory = result.messages;
        session.totalTokens = result.tokensAfter;
        session.compactionCount += 1;
        flushState = markFlushCompleted(flushState);
        flushState = { ...flushState, totalTokens: result.tokensAfter };

        const saved = result.tokensBefore - result.tokensAfter;
        log.info(`[DingTalk] Compaction completed, saved ${formatTokenCount(saved)} tokens`);

        const summaryText = (result.summary || '').trim();
        if (summaryText && options) {
            await persistSessionEvent({
                role: 'summary',
                content: summaryText,
                conversationId: options.conversationId,
                sessionKey: options.sessionKey,
                store: options.store,
                workspacePath: options.workspacePath,
                config: options.config,
                log,
                metadata: {
                    type: 'compaction_summary',
                    tokensBefore: result.tokensBefore,
                    tokensAfter: result.tokensAfter,
                    tokensSaved: saved,
                    messageCountAfter: result.messages.length,
                },
            });
        }

        return flushState;
    } catch (error) {
        log.error('[DingTalk] Compaction failed:', String(error));
        return flushState;
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

export async function flushSessionsOnShutdown(params: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: any;
    config: Config;
    log: Logger;
    drainTimeoutMs?: number;
    flushTimeoutMs?: number;
}): Promise<{
    drained: boolean;
    drainedConversations: number;
    sessionsTotal: number;
    sessionsFlushed: number;
    sessionsFlushFailed: number;
    sessionsPersisted: number;
}> {
    const { agent, config, log } = params;
    const drainTimeoutMs = Math.max(1000, Math.floor(params.drainTimeoutMs ?? 15000));
    const flushTimeoutMs = Math.max(1000, Math.floor(params.flushTimeoutMs ?? 30000));

    let drained = true;
    const pendingTasks = Array.from(conversationQueue.values());
    if (pendingTasks.length > 0) {
        log.info(`[DingTalk] Waiting pending conversations before shutdown: ${pendingTasks.length}`);
        try {
            await withTimeout(
                Promise.allSettled(pendingTasks).then(() => undefined),
                drainTimeoutMs,
                `drain timeout after ${drainTimeoutMs}ms`
            );
        } catch (error) {
            drained = false;
            log.warn(`[DingTalk] Pending conversation drain skipped: ${String(error)}`);
        }
    }

    const store = await getSessionStore(config, log);
    const entries = Array.from(sessionCache.entries());
    let sessionsFlushed = 0;
    let sessionsFlushFailed = 0;
    let sessionsPersisted = 0;

    for (const [sessionKey, session] of entries) {
        const shouldFlush = session.messageHistory.length > 0 && session.totalTokens > 0;
        if (shouldFlush) {
            try {
                const flushState: MemoryFlushState = {
                    ...createMemoryFlushState(),
                    totalTokens: session.totalTokens,
                };
                const nextState = await withTimeout(
                    executeMemoryFlush(agent, session, flushState, log),
                    flushTimeoutMs,
                    `memory flush timeout after ${flushTimeoutMs}ms`
                );
                session.totalTokens = nextState.totalTokens;
                sessionsFlushed += 1;
            } catch (error) {
                sessionsFlushFailed += 1;
                log.warn(`[DingTalk] Shutdown memory flush failed for ${sessionKey}: ${String(error)}`);
            }
        }

        session.lastUpdated = Date.now();
        await persistSession({
            sessionKey,
            scopeKey: sessionKey,
            session,
            store,
            log,
        });
        sessionsPersisted += 1;
    }

    return {
        drained,
        drainedConversations: pendingTasks.length,
        sessionsTotal: entries.length,
        sessionsFlushed,
        sessionsFlushFailed,
        sessionsPersisted,
    };
}

export async function closeSessionResources(log: Logger): Promise<void> {
    if (sessionStore) {
        try {
            await sessionStore.close();
        } catch (error) {
            log.warn(`[DingTalk] Session store close failed: ${String(error)}`);
        }
    }
    sessionStore = null;
    sessionStoreInitPromise = null;
    sessionStoreConfigKey = '';
    sessionCache.clear();
    hydratedThreadIds.clear();
}
