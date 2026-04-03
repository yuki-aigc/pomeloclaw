import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server as HTTPServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RuntimeAgent } from './agent.js';
import { loadConfig } from './config.js';
import { ConversationRuntime } from './conversation/runtime.js';
import { createChatModel } from './llm.js';
import {
    createMemoryFlushState,
    recordSessionEvent,
    recordSessionTranscript,
    shouldTriggerMemoryFlush,
    type MemoryFlushState,
} from './middleware/index.js';
import { withForcedMemoryScope, type MemoryScope } from './middleware/memory-scope.js';
import { createRuntimeConsoleLogger, terminalColors as colors } from './channels/runtime-entry.js';
import { prepareConversationUserMessages, withTimeout } from './channels/conversation-utils.js';
import { executeMemoryFlushCore, pickInvokeResponse } from './channels/agent-execution.js';
import type { RuntimeLogWriter } from './log/runtime.js';
import { createSkillDirectoryMonitor } from './skills/index.js';
import { applyTurnTokenAccounting } from './channels/turn-accounting.js';
import { buildHookTaskQueryResponse, HookTaskManager } from './hooks/service.js';
import type { AgentHookRequest, HookLogger } from './hooks/types.js';

const MAX_RENDERED_PAYLOAD_CHARS = 24_000;

interface HookConversationRuntimeState {
    threadId: string;
    flushState: MemoryFlushState;
    totalInputTokens: number;
    totalOutputTokens: number;
    lastUpdatedAt: number;
    scope: MemoryScope;
    startupMemoryInjected: boolean;
}

export interface HooksServiceRuntime {
    shutdown: () => Promise<void>;
}

function normalizePath(path?: string, fallback: string = '/hooks/agent'): string {
    const normalized = path?.trim() || fallback;
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function buildTasksBasePath(hookPath: string): string {
    return `${hookPath.replace(/\/+$/, '')}/tasks`;
}

function sanitizeScopePart(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return 'unknown';
    return trimmed.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function createHookThreadId(sessionKey: string): string {
    return `hook-${sanitizeScopePart(sessionKey)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function createHookScope(sessionKey: string): MemoryScope {
    return {
        key: `direct_hook_${sanitizeScopePart(sessionKey)}`,
        kind: 'direct',
    };
}

function getOrCreateHookState(
    states: Map<string, HookConversationRuntimeState>,
    sessionKey: string,
): HookConversationRuntimeState {
    const existing = states.get(sessionKey);
    if (existing) {
        return existing;
    }

    const created: HookConversationRuntimeState = {
        threadId: createHookThreadId(sessionKey),
        flushState: createMemoryFlushState(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastUpdatedAt: Date.now(),
        scope: createHookScope(sessionKey),
        startupMemoryInjected: false,
    };
    states.set(sessionKey, created);
    return created;
}

function truncateForModel(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}\n...<truncated ${text.length - maxChars} chars>`;
}

function stringifyForPrompt(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '[unserializable payload]';
    }
}

function buildHookUserText(request: AgentHookRequest): string {
    const parts = [request.prompt.trim()];
    const contextLines = [
        `request_id: ${request.requestId}`,
        `session_key: ${request.sessionKey}`,
    ];
    if (contextLines.length > 0) {
        parts.push('', '## Hook Context', ...contextLines);
    }
    if (request.metadata && Object.keys(request.metadata).length > 0) {
        parts.push('', '## Hook Metadata', truncateForModel(stringifyForPrompt(request.metadata), MAX_RENDERED_PAYLOAD_CHARS));
    }
    if (request.payload !== undefined) {
        parts.push('', '## Hook Payload', truncateForModel(stringifyForPrompt(request.payload), MAX_RENDERED_PAYLOAD_CHARS));
    }
    return parts.join('\n');
}

async function persistHookTurn(params: {
    workspacePath: string;
    config: ReturnType<typeof loadConfig>;
    log: HookLogger;
    sessionKey: string;
    role: 'user' | 'assistant';
    content: string;
    requestId: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const text = params.content.trim();
    if (!text) {
        return;
    }

    await recordSessionTranscript(params.workspacePath, params.config, params.role, text).catch((error) => {
        params.log.debug(`[Hooks] Transcript(${params.role}) write skipped:`, String(error));
    });

    await recordSessionEvent(params.workspacePath, params.config, {
        role: params.role,
        content: text,
        conversationId: params.sessionKey,
        channel: 'hooks',
        metadata: {
            requestId: params.requestId,
            ...(params.metadata || {}),
        },
        fallbackToTranscript: false,
    }).catch((error) => {
        params.log.debug(`[Hooks] Session event(${params.role}) write skipped:`, String(error));
    });
}

async function executeHookMemoryFlush(params: {
    agent: RuntimeAgent;
    config: ReturnType<typeof loadConfig>;
    sessionKey: string;
    state: HookConversationRuntimeState;
    scope: MemoryScope;
    log: HookLogger;
}): Promise<boolean> {
    try {
        const result = await withForcedMemoryScope(
            params.scope,
            () => executeMemoryFlushCore({
                agent: params.agent,
                threadId: params.state.threadId,
                recursionLimit: params.config.agent.recursion_limit,
                flushState: params.state.flushState,
                compactionConfig: params.config.agent.compaction,
                version: 'v2',
            }),
        );

        params.state.flushState = result.nextState;
        params.state.threadId = createHookThreadId(params.sessionKey);
        params.log.info(`[Hooks] Memory flush completed, rotated thread for session_key=${params.sessionKey}`);
        return true;
    } catch (error) {
        params.log.warn(`[Hooks] Memory flush failed (${params.sessionKey}): ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let currentSize = 0;
    for await (const chunk of req) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        chunks.push(buffer);
        currentSize += buffer.length;
        if (currentSize > maxBytes) {
            throw new Error('请求体过大');
        }
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
        return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('请求体必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
}

function readHeaderToken(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string') {
        return value.trim() || undefined;
    }
    if (Array.isArray(value)) {
        const first = value.find((item) => typeof item === 'string' && item.trim());
        return first?.trim() || undefined;
    }
    return undefined;
}

function ensureHooksAuthorized(
    req: IncomingMessage,
    res: ServerResponse,
    expectedToken: string | undefined,
): boolean {
    if (!expectedToken) {
        return true;
    }

    const authorization = readHeaderToken(req.headers.authorization);
    if (authorization) {
        const bearer = authorization.match(/^Bearer\s+(.+)$/i);
        const token = (bearer?.[1] || authorization).trim();
        if (token === expectedToken) {
            return true;
        }
    }

    const customToken = readHeaderToken(req.headers['x-hooks-auth-token']) || readHeaderToken(req.headers['x-hooks-token']);
    if (customToken?.trim() === expectedToken) {
        return true;
    }

    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        ok: false,
        error: {
            code: 'unauthorized',
            message: '缺少或无效的 hooks token',
        },
    }));
    return false;
}

export async function startHooksService(options?: {
    registerSignalHandlers?: boolean;
    exitOnShutdown?: boolean;
    logWriter?: RuntimeLogWriter;
}): Promise<HooksServiceRuntime> {
    const config = loadConfig();
    const hooksConfig = config.hooks;
    if (!hooksConfig?.enabled) {
        throw new Error('hooks 未启用，请检查 config.hooks.enabled');
    }

    const registerSignalHandlers = options?.registerSignalHandlers ?? true;
    const exitOnShutdown = options?.exitOnShutdown ?? true;
    const log = createRuntimeConsoleLogger({
        debug: hooksConfig.debug,
        logWriter: options?.logWriter,
    });
    const conversationRuntime = new ConversationRuntime({
        config,
        runtimeChannel: 'web',
    });
    await conversationRuntime.initialize();

    let currentAgent = conversationRuntime.getAgent();
    let compactionModelPromise: Promise<BaseChatModel> | null = null;
    let isShuttingDown = false;
    let server: HTTPServer | null = null;
    const conversationStates = new Map<string, HookConversationRuntimeState>();
    const memoryWorkspacePath = resolve(process.cwd(), config.agent.workspace);
    const skillsPath = resolve(process.cwd(), config.agent.skills_dir);
    const hookPath = normalizePath(hooksConfig.path, '/hooks/agent');
    const tasksBasePath = buildTasksBasePath(hookPath);
    const skillMonitor = createSkillDirectoryMonitor({
        skillsDir: skillsPath,
        logger: log,
        onChange: () => {
            conversationRuntime.requestReload();
            log.info('[Hooks] Skills changed on disk, reload scheduled for next request.');
        },
    });

    const getCompactionModel = async (): Promise<BaseChatModel> => {
        if (!compactionModelPromise) {
            compactionModelPromise = createChatModel(config, { temperature: 0 });
        }
        return compactionModelPromise;
    };

    const hookManager = new HookTaskManager({
        logger: log,
        maxConcurrentTasks: hooksConfig.maxConcurrentTasks,
        taskTtlMs: hooksConfig.taskTtlMs,
        callbackDefaults: hooksConfig.callback,
        executeTask: async (request) => {
            await conversationRuntime.reloadIfNeeded();
            currentAgent = conversationRuntime.getAgent();

            const sessionState = getOrCreateHookState(conversationStates, request.sessionKey);
            sessionState.lastUpdatedAt = Date.now();
            const userText = buildHookUserText(request);
            const compactionModel = await getCompactionModel();
            const scope = sessionState.scope;
            const shouldInjectStartupMemory = !sessionState.startupMemoryInjected;

            const preparedUserMessages = await prepareConversationUserMessages({
                userText,
                workspacePath: memoryWorkspacePath,
                scopeKey: scope.key,
                includeStartupMemory: shouldInjectStartupMemory,
            });
            if (shouldInjectStartupMemory) {
                sessionState.startupMemoryInjected = true;
            }

            await persistHookTurn({
                workspacePath: memoryWorkspacePath,
                config,
                log,
                sessionKey: request.sessionKey,
                role: 'user',
                content: userText,
                requestId: request.requestId,
                metadata: {
                    scopeKey: scope.key,
                    direction: 'inbound',
                },
            });

            const inputAccounting = await applyTurnTokenAccounting({
                flushState: sessionState.flushState,
                text: userText,
                model: compactionModel,
                compactionConfig: config.agent.compaction,
            });
            sessionState.flushState = inputAccounting.flushState;
            sessionState.totalInputTokens += inputAccounting.tokenDelta;

            const invocationMessages = await conversationRuntime.buildBootstrapMessages({
                threadId: sessionState.threadId,
                workspacePath: memoryWorkspacePath,
                scopeKey: scope.key,
            });
            invocationMessages.push(...preparedUserMessages.userMessages);

            const invokeResult = await withForcedMemoryScope(
                scope,
                () => currentAgent.invoke(
                    { messages: invocationMessages },
                    {
                        configurable: { thread_id: sessionState.threadId },
                        recursionLimit: config.agent.recursion_limit,
                        version: 'v2',
                    }
                ),
            );

            const replyText = pickInvokeResponse(invokeResult) || '已处理，但没有可返回的文本结果。';

            await persistHookTurn({
                workspacePath: memoryWorkspacePath,
                config,
                log,
                sessionKey: request.sessionKey,
                role: 'assistant',
                content: replyText,
                requestId: request.requestId,
                metadata: {
                    scopeKey: scope.key,
                    direction: 'outbound',
                },
            });

            const outputAccounting = await applyTurnTokenAccounting({
                flushState: sessionState.flushState,
                text: replyText,
                model: compactionModel,
                compactionConfig: config.agent.compaction,
            });
            sessionState.flushState = outputAccounting.flushState;
            sessionState.totalOutputTokens += outputAccounting.tokenDelta;
            sessionState.lastUpdatedAt = Date.now();

            if (shouldTriggerMemoryFlush(sessionState.flushState, config.agent.compaction)) {
                await executeHookMemoryFlush({
                    agent: currentAgent,
                    config,
                    sessionKey: request.sessionKey,
                    state: sessionState,
                    scope,
                    log,
                });
            }

            return {
                text: replyText,
                metadata: {
                    scopeKey: scope.key,
                    threadId: sessionState.threadId,
                    totalInputTokens: sessionState.totalInputTokens,
                    totalOutputTokens: sessionState.totalOutputTokens,
                },
            };
        },
    });

    server = createServer((req, res) => {
        void (async () => {
            const method = req.method || 'GET';
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

            if (method === 'GET' && url.pathname === '/healthz') {
                res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('ok');
                return;
            }

            if (method === 'POST' && url.pathname === hookPath) {
                if (!ensureHooksAuthorized(req, res, hooksConfig.authToken?.trim() || undefined)) {
                    return;
                }

                try {
                    const body = await readJsonBody(req, hooksConfig.maxPayloadBytes ?? 256 * 1024);
                    const accepted = await hookManager.accept(body);
                    res.writeHead(202, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify(accepted));
                } catch (error) {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: false,
                        error: {
                            code: 'bad_request',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    }));
                }
                return;
            }

            if (method === 'GET' && url.pathname.startsWith(`${tasksBasePath}/`)) {
                if (!ensureHooksAuthorized(req, res, hooksConfig.authToken?.trim() || undefined)) {
                    return;
                }

                const requestId = decodeURIComponent(url.pathname.slice(tasksBasePath.length + 1)).trim();
                if (!requestId) {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: false,
                        error: {
                            code: 'bad_request',
                            message: 'request_id 不能为空',
                        },
                    }));
                    return;
                }

                const task = hookManager.getTask(requestId);
                if (!task) {
                    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: false,
                        error: {
                            code: 'not_found',
                            message: `未找到任务: ${requestId}`,
                        },
                    }));
                    return;
                }

                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(JSON.stringify(buildHookTaskQueryResponse(task)));
                return;
            }

            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
        })().catch((error) => {
            log.error('[Hooks] http request failed:', error instanceof Error ? error.message : String(error));
            if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            }
            res.end(JSON.stringify({
                ok: false,
                error: {
                    code: 'internal_error',
                    message: 'internal error',
                },
            }));
        });
    });

    server.on('error', (error) => {
        log.error('[Hooks] http server error:', error instanceof Error ? error.message : String(error));
    });

    await new Promise<void>((resolvePromise, reject) => {
        server!.listen(hooksConfig.port, hooksConfig.host, () => resolvePromise());
        server!.once('error', reject);
    });

    log.info(`[Hooks] Service ready at http://${hooksConfig.host}:${hooksConfig.port}${hookPath}`);
    log.info(`[Hooks] Task query ready at http://${hooksConfig.host}:${hooksConfig.port}${tasksBasePath}/:request_id`);
    log.info(`[Hooks] Health check at http://${hooksConfig.host}:${hooksConfig.port}/healthz`);
    console.log();
    console.log(`${colors.gray}Hooks endpoint is ready. Press Ctrl+C to stop the Hooks service.${colors.reset}`);
    console.log();

    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        hookManager.stop();

        log.info('[Hooks] Shutting down...');
        if (server) {
            const current = server;
            server = null;
            await new Promise<void>((resolvePromise) => {
                current.close(() => resolvePromise());
            });
        }

        try {
            await withTimeout(
                hookManager.waitForIdle(),
                hooksConfig.shutdownDrainTimeoutMs ?? 15000,
                `hooks drain timeout after ${hooksConfig.shutdownDrainTimeoutMs ?? 15000}ms`,
            );
        } catch (error) {
            log.warn('[Hooks] drain pending tasks skipped:', error instanceof Error ? error.message : String(error));
        }

        skillMonitor.close();

        try {
            await conversationRuntime.close();
        } catch (error) {
            log.warn('[Hooks] cleanup failed:', error instanceof Error ? error.message : String(error));
        }

        conversationStates.clear();

        if (exitOnShutdown) {
            process.exit(0);
        }
    };

    if (registerSignalHandlers) {
        process.on('SIGINT', () => {
            void shutdown();
        });
        process.on('SIGTERM', () => {
            void shutdown();
        });
    }

    return { shutdown };
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
    startHooksService({
        registerSignalHandlers: true,
        exitOnShutdown: true,
    }).catch((error) => {
        console.error(`${colors.red}Fatal error:${colors.reset}`, error);
        process.exit(1);
    });
}
