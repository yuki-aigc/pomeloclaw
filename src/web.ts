import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent } from './agent.js';
import { loadConfig } from './config.js';
import { createChatModel } from './llm.js';
import { createWebChannelAdapter, type WebLogger, type WebChannelAdapter } from './channels/web/index.js';
import { GatewayService } from './channels/gateway/index.js';
import { buildPromptBootstrapMessage } from './prompt/bootstrap.js';
import {
    buildMemoryFlushPrompt,
    createMemoryFlushState,
    isNoReplyResponse,
    markFlushCompleted,
    recordSessionEvent,
    recordSessionTranscript,
    shouldTriggerMemoryFlush,
    updateTokenCountWithModel,
    type MemoryFlushState,
} from './middleware/index.js';
import { resolveMemoryScope } from './middleware/memory-scope.js';
import { consumeQueuedWebReplyFiles } from './channels/web/context.js';
import {
    createRuntimeConsoleLogger,
    printChannelHeader,
    terminalColors as colors,
    toGatewayLogger,
} from './channels/runtime-entry.js';
import {
    extractBestReadableReplyFromMessages,
    extractReplyTextFromEventData,
    extractStreamChunkText,
    isLikelyStructuredToolPayload,
    isLikelyToolCallResidue,
    pickBestUserFacingResponse,
    sanitizeUserFacingText,
} from './channels/streaming.js';
import type { RuntimeLogWriter } from './log/runtime.js';

const conversationQueue = new Map<string, Promise<void>>();

interface WebConversationRuntimeState {
    threadId: string;
    flushState: MemoryFlushState;
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

function enqueueConversationTask(
    conversationId: string,
    task: () => Promise<void>,
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

function createWebThreadId(conversationId: string): string {
    return `web-${conversationId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function getOrCreateConversationState(
    conversationStates: Map<string, WebConversationRuntimeState>,
    conversationId: string,
): WebConversationRuntimeState {
    const existing = conversationStates.get(conversationId);
    if (existing) {
        return existing;
    }

    const created: WebConversationRuntimeState = {
        threadId: createWebThreadId(conversationId),
        flushState: createMemoryFlushState(),
    };
    conversationStates.set(conversationId, created);
    return created;
}

async function persistWebTurn(params: {
    workspacePath: string;
    config: ReturnType<typeof loadConfig>;
    log: WebLogger;
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    messageId: string;
    senderId: string;
    senderName: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const text = params.content.trim();
    if (!text) {
        return;
    }

    await recordSessionTranscript(params.workspacePath, params.config, params.role, text).catch((error) => {
        params.log.debug(`[Web] Transcript(${params.role}) write skipped:`, String(error));
    });

    await recordSessionEvent(params.workspacePath, params.config, {
        role: params.role,
        content: text,
        conversationId: params.conversationId,
        channel: 'web',
        metadata: {
            messageId: params.messageId,
            senderId: params.senderId,
            senderName: params.senderName,
            ...(params.metadata || {}),
        },
        fallbackToTranscript: false,
    }).catch((error) => {
        params.log.debug(`[Web] Session event(${params.role}) write skipped:`, String(error));
    });
}

async function executeWebMemoryFlush(params: {
    agent: Awaited<ReturnType<typeof createAgent>>['agent'];
    config: ReturnType<typeof loadConfig>;
    conversationId: string;
    state: WebConversationRuntimeState;
    log: WebLogger;
}): Promise<boolean> {
    try {
        const result = await params.agent.invoke(
            {
                messages: [{ role: 'user', content: buildMemoryFlushPrompt() }],
            },
            {
                configurable: { thread_id: params.state.threadId },
                recursionLimit: params.config.agent.recursion_limit,
                version: 'v2',
            },
        );
        const messages = Array.isArray(result.messages) ? result.messages : [];
        const lastMessage = messages[messages.length - 1];
        const content = typeof lastMessage?.content === 'string' ? lastMessage.content.trim() : '';
        if (content && !isNoReplyResponse(content)) {
            params.log.debug(`[Web] Memory flush returned visible output (${params.conversationId}): ${content.slice(0, 120)}`);
        }

        params.state.flushState = markFlushCompleted(params.state.flushState);
        params.state.threadId = createWebThreadId(params.conversationId);
        params.log.info(`[Web] Memory flush completed, rotated thread for conversation=${params.conversationId}`);
        return true;
    } catch (error) {
        params.log.warn(`[Web] Memory flush failed (${params.conversationId}): ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

async function flushWebConversationsOnShutdown(params: {
    agent: Awaited<ReturnType<typeof createAgent>>['agent'];
    config: ReturnType<typeof loadConfig>;
    log: WebLogger;
    conversationStates: Map<string, WebConversationRuntimeState>;
    drainTimeoutMs?: number;
    flushTimeoutMs?: number;
}): Promise<{
    drained: boolean;
    drainedConversations: number;
    conversationsTotal: number;
    conversationsFlushed: number;
    conversationsFlushFailed: number;
}> {
    const drainTimeoutMs = Math.max(1000, Math.floor(params.drainTimeoutMs ?? 15000));
    const flushTimeoutMs = Math.max(1000, Math.floor(params.flushTimeoutMs ?? 30000));

    let drained = true;
    const pendingTasks = Array.from(conversationQueue.values());
    if (pendingTasks.length > 0) {
        params.log.info(`[Web] Waiting pending conversations before shutdown: ${pendingTasks.length}`);
        try {
            await withTimeout(
                Promise.allSettled(pendingTasks).then(() => undefined),
                drainTimeoutMs,
                `drain timeout after ${drainTimeoutMs}ms`,
            );
        } catch (error) {
            drained = false;
            params.log.warn(`[Web] Pending conversation drain skipped: ${String(error)}`);
        }
    }

    const entries = Array.from(params.conversationStates.entries());
    let conversationsFlushed = 0;
    let conversationsFlushFailed = 0;

    for (const [conversationId, state] of entries) {
        if (state.flushState.totalTokens <= 0) {
            continue;
        }
        try {
            await withTimeout(
                executeWebMemoryFlush({
                    agent: params.agent,
                    config: params.config,
                    conversationId,
                    state,
                    log: params.log,
                }),
                flushTimeoutMs,
                `memory flush timeout after ${flushTimeoutMs}ms`,
            );
            conversationsFlushed += 1;
        } catch (error) {
            conversationsFlushFailed += 1;
            params.log.warn(`[Web] Shutdown memory flush failed for ${conversationId}: ${String(error)}`);
        }
    }

    return {
        drained,
        drainedConversations: pendingTasks.length,
        conversationsTotal: entries.length,
        conversationsFlushed,
        conversationsFlushFailed,
    };
}

export async function startWebService(options?: {
    registerSignalHandlers?: boolean;
    exitOnShutdown?: boolean;
    logWriter?: RuntimeLogWriter;
}): Promise<{ shutdown: () => Promise<void> }> {
    const registerSignalHandlers = options?.registerSignalHandlers ?? false;
    const exitOnShutdown = options?.exitOnShutdown ?? false;
    const config = loadConfig();

    if (!config.web) {
        throw new Error('Web configuration not found in config.json');
    }
    if (!config.web.enabled) {
        throw new Error('Web channel is disabled (config.web.enabled=false)');
    }

    const webConfig = config.web;
    const log: WebLogger = createRuntimeConsoleLogger({
        debug: webConfig.debug,
        logWriter: options?.logWriter,
    });

    printChannelHeader({
        config,
        modeLabel: 'Web Mode',
        statusLines: ['Streaming WebSocket + Built-in UI'],
    });

    log.info('[Web] Initializing agent...');
    const initialAgentContext = await createAgent(config, {
        runtimeChannel: 'web',
    });

    let currentAgent = initialAgentContext.agent;
    let cleanup = initialAgentContext.cleanup;
    let gateway: GatewayService | null = null;
    let webAdapter: WebChannelAdapter | null = null;
    let isShuttingDown = false;
    const bootstrappedThreads = new Set<string>();
    const conversationStates = new Map<string, WebConversationRuntimeState>();
    const memoryWorkspacePath = resolve(process.cwd(), config.agent.workspace);
    let compactionModelPromise: Promise<BaseChatModel> | null = null;

    const getCompactionModel = async (): Promise<BaseChatModel> => {
        if (!compactionModelPromise) {
            compactionModelPromise = createChatModel(config, { temperature: 0 });
        }
        return compactionModelPromise;
    };

    gateway = new GatewayService({
        onProcessInbound: async (message) => {
            if (message.channel !== 'web') {
                return { skipReply: true };
            }
            const adapter = webAdapter;
            if (!adapter) {
                throw new Error('Web adapter is not ready');
            }

            await enqueueConversationTask(message.conversationId, async () => {
                const userText = message.text.trim();
                if (!userText) {
                    await adapter.sendStreamEvent({
                        inbound: message,
                        payload: {
                            type: 'reply_error',
                            sourceMessageId: message.messageId,
                            request_id: message.messageId,
                            conversationId: message.conversationId,
                            session_id: message.conversationId,
                            message: '收到空消息，无法处理。',
                            timestamp: Date.now(),
                        },
                    });
                    return;
                }

                const conversationState = getOrCreateConversationState(conversationStates, message.conversationId);
                const compactionModel = await getCompactionModel();
                const scope = resolveMemoryScope(config.agent.memory.session_isolation);
                await persistWebTurn({
                    workspacePath: memoryWorkspacePath,
                    config,
                    log,
                    conversationId: message.conversationId,
                    role: 'user',
                    content: userText,
                    messageId: message.messageId,
                    senderId: message.senderId,
                    senderName: message.senderName,
                    metadata: {
                        scopeKey: scope.key,
                        direction: 'inbound',
                    },
                });
                conversationState.flushState = await updateTokenCountWithModel(
                    conversationState.flushState,
                    userText,
                    compactionModel,
                    config.agent.compaction,
                );

                const threadId = conversationState.threadId;
                const invocationMessages: Array<{ role: 'user'; content: string }> = [];

                if (!bootstrappedThreads.has(threadId)) {
                    const bootstrapPromptMessage = await buildPromptBootstrapMessage({
                        workspacePath: memoryWorkspacePath,
                        scopeKey: scope.key,
                    });
                    if (bootstrapPromptMessage) {
                        invocationMessages.push(bootstrapPromptMessage);
                    }
                    bootstrappedThreads.add(threadId);
                }

                invocationMessages.push({
                    role: 'user',
                    content: userText,
                });

                await adapter.sendStreamEvent({
                    inbound: message,
                    payload: {
                        type: 'reply_start',
                        sourceMessageId: message.messageId,
                        request_id: message.messageId,
                        conversationId: message.conversationId,
                        session_id: message.conversationId,
                        timestamp: Date.now(),
                    },
                });

                let rawStreamResponse = '';
                let visibleStreamResponse = '';
                let fullResponse = '';
                let finalOutputFromEvents = '';
                let sawToolCall = false;
                let attachments = [];

                try {
                    const eventStream = currentAgent.streamEvents(
                        { messages: invocationMessages },
                        {
                            configurable: { thread_id: threadId },
                            recursionLimit: config.agent.recursion_limit,
                            version: 'v2',
                        },
                    );

                    for await (const event of eventStream) {
                        if (event.event === 'on_chat_model_stream') {
                            const delta = extractStreamChunkText(event.data?.chunk?.content);
                            if (!delta) {
                                continue;
                            }
                            rawStreamResponse += delta;
                            const sanitizedCandidate = sanitizeUserFacingText(rawStreamResponse);
                            let deltaToSend = '';
                            if (!visibleStreamResponse && sanitizedCandidate) {
                                deltaToSend = sanitizedCandidate;
                                visibleStreamResponse = sanitizedCandidate;
                            } else if (sanitizedCandidate.startsWith(visibleStreamResponse)) {
                                deltaToSend = sanitizedCandidate.slice(visibleStreamResponse.length);
                                visibleStreamResponse = sanitizedCandidate;
                            }
                            if (!deltaToSend) {
                                continue;
                            }
                            await adapter.sendStreamEvent({
                                inbound: message,
                                payload: {
                                    type: 'reply_delta',
                                    sourceMessageId: message.messageId,
                                    request_id: message.messageId,
                                    conversationId: message.conversationId,
                                    session_id: message.conversationId,
                                    delta: deltaToSend,
                                    timestamp: Date.now(),
                                },
                            });
                            continue;
                        }

                        if (event.event === 'on_tool_start') {
                            sawToolCall = true;
                            await adapter.sendStreamEvent({
                                inbound: message,
                                payload: {
                                    type: 'tool_start',
                                    sourceMessageId: message.messageId,
                                    request_id: message.messageId,
                                    conversationId: message.conversationId,
                                    session_id: message.conversationId,
                                    toolName: event.name,
                                    timestamp: Date.now(),
                                },
                            });
                            continue;
                        }

                        if (event.event === 'on_tool_end') {
                            await adapter.sendStreamEvent({
                                inbound: message,
                                payload: {
                                    type: 'tool_end',
                                    sourceMessageId: message.messageId,
                                    request_id: message.messageId,
                                    conversationId: message.conversationId,
                                    session_id: message.conversationId,
                                    toolName: event.name,
                                    timestamp: Date.now(),
                                },
                            });
                            continue;
                        }

                        if (event.event === 'on_chat_model_end' || event.event === 'on_chain_end') {
                            const extracted = sanitizeUserFacingText(extractReplyTextFromEventData(event.data));
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
                        sanitizeUserFacingText(rawStreamResponse),
                        rawStreamResponse,
                    ], {
                        sawToolCall,
                    });
                    attachments = await adapter.registerReplyAttachments(consumeQueuedWebReplyFiles());

                    if (!fullResponse && attachments.length > 0) {
                        fullResponse = '✅ 文件已生成，请下载附件。';
                    }
                    if (!fullResponse) {
                        fullResponse = '已处理，但没有可返回的文本结果。';
                    }

                    await adapter.sendStreamEvent({
                        inbound: message,
                        payload: {
                            type: 'reply_final',
                            sourceMessageId: message.messageId,
                            request_id: message.messageId,
                            conversationId: message.conversationId,
                            session_id: message.conversationId,
                            text: fullResponse,
                            attachments,
                            finishReason: 'completed',
                            timestamp: Date.now(),
                        },
                    });

                    await persistWebTurn({
                        workspacePath: memoryWorkspacePath,
                        config,
                        log,
                        conversationId: message.conversationId,
                        role: 'assistant',
                        content: fullResponse,
                        messageId: message.messageId,
                        senderId: message.senderId,
                        senderName: message.senderName,
                        metadata: {
                            scopeKey: scope.key,
                            direction: 'outbound',
                            attachmentCount: attachments.length,
                        },
                    });
                    conversationState.flushState = await updateTokenCountWithModel(
                        conversationState.flushState,
                        fullResponse,
                        compactionModel,
                        config.agent.compaction,
                    );
                    if (shouldTriggerMemoryFlush(conversationState.flushState, config.agent.compaction)) {
                        await executeWebMemoryFlush({
                            agent: currentAgent,
                            config,
                            conversationId: message.conversationId,
                            state: conversationState,
                            log,
                        });
                    }
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    log.warn(`[Web] stream failed (${message.conversationId}): ${reason}`);
                    await adapter.sendStreamEvent({
                        inbound: message,
                        payload: {
                            type: 'reply_error',
                            sourceMessageId: message.messageId,
                            request_id: message.messageId,
                            conversationId: message.conversationId,
                            session_id: message.conversationId,
                            message: reason,
                            timestamp: Date.now(),
                        },
                    });
                }
            });

            return { skipReply: true };
        },
        logger: toGatewayLogger(log),
    });

    webAdapter = createWebChannelAdapter({
        config: webConfig,
        log,
        workspaceRoot: memoryWorkspacePath,
    });
    gateway.registerAdapter(webAdapter);
    await gateway.start();

    log.info(`[Web] UI available at http://${webConfig.host}:${webConfig.port}${webConfig.uiPath}`);
    log.info('[Web] Service started and ready for browser clients.');
    console.log();
    console.log(`${colors.gray}Open the Web UI in your browser. Press Ctrl+C to stop the Web service.${colors.reset}`);
    console.log();

    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        log.info('[Web] Shutting down...');
        try {
            const shutdownResult = await flushWebConversationsOnShutdown({
                agent: currentAgent,
                config,
                log,
                conversationStates,
                drainTimeoutMs: 15000,
                flushTimeoutMs: 30000,
            });
            log.info(
                `[Web] Shutdown flush summary: drained=${shutdownResult.drained}`
                + ` pending=${shutdownResult.drainedConversations}`
                + ` conversations=${shutdownResult.conversationsTotal}`
                + ` flushed=${shutdownResult.conversationsFlushed}`
                + ` failed=${shutdownResult.conversationsFlushFailed}`,
            );
        } catch (error) {
            log.warn('[Web] shutdown flush failed:', error instanceof Error ? error.message : String(error));
        }

        if (gateway) {
            try {
                await gateway.stop();
            } catch (error) {
                log.warn('[Web] gateway stop failed:', error instanceof Error ? error.message : String(error));
            }
        }

        if (cleanup) {
            try {
                await cleanup();
            } catch (error) {
                log.warn('[Web] MCP cleanup failed:', error instanceof Error ? error.message : String(error));
            }
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
    startWebService({
        registerSignalHandlers: true,
        exitOnShutdown: true,
    }).catch((error) => {
        console.error(`${colors.red}Fatal error:${colors.reset}`, error);
        process.exit(1);
    });
}
