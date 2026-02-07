/**
 * DingTalk Message Handler
 * Handles incoming messages and agent interaction
 */

import crypto from 'node:crypto';
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
    updateTokenCount,
    shouldTriggerMemoryFlush,
    markFlushCompleted,
    isNoReplyResponse,
    MEMORY_FLUSH_SYSTEM_PROMPT,
    MEMORY_FLUSH_USER_PROMPT,
    type MemoryFlushState,
} from '../../middleware/index.js';
import {
    shouldAutoCompact,
    compactMessages,
    formatTokenCount,
} from '../../compaction/index.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Config } from '../../config.js';
import {
    createChatModel,
    getActiveModelAlias,
    getModelCacheKey,
    listConfiguredModels,
} from '../../llm.js';

// Session state cache (conversationId -> SessionState)
const sessionCache = new Map<string, SessionState>();
let cachedCompactionModel: BaseChatModel | null = null;
let cachedCompactionModelKey = '';

// Per-conversation processing queue to ensure serial handling
const conversationQueue = new Map<string, Promise<void>>();

// Session TTL (2 hours)
const SESSION_TTL = 2 * 60 * 60 * 1000;

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
function getOrCreateSession(conversationId: string): SessionState {
    const existing = sessionCache.get(conversationId);
    if (existing && Date.now() - existing.lastUpdated < SESSION_TTL) {
        return existing;
    }

    const newSession: SessionState = {
        threadId: `dingtalk-${conversationId}-${crypto.randomUUID().slice(0, 8)}`,
        messageHistory: [],
        totalTokens: 0,
        lastUpdated: Date.now(),
    };
    sessionCache.set(conversationId, newSession);
    return newSession;
}

/**
 * Clean up expired sessions
 */
function cleanupSessions(): void {
    const now = Date.now();
    for (const [id, session] of sessionCache.entries()) {
        if (now - session.lastUpdated > SESSION_TTL) {
            sessionCache.delete(id);
        }
    }
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

export interface MessageHandlerContext {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: any;
    config: Config;
    dingtalkConfig: DingTalkConfig;
    log: Logger;
    switchModel?: (alias: string) => Promise<{ alias: string; model: string }>;
}

type ModelSlashCommand = { type: 'list' } | { type: 'switch'; alias: string };

function parseModelSlashCommand(input: string): ModelSlashCommand | null {
    const text = input.trim();
    if (text === '/models') {
        return { type: 'list' };
    }
    if (text === '/model') {
        return { type: 'switch', alias: '' };
    }
    if (text.startsWith('/model ')) {
        return { type: 'switch', alias: text.slice('/model'.length).trim() };
    }
    return null;
}

async function tryHandleModelCommand(params: {
    text: string;
    ctx: MessageHandlerContext;
    sessionWebhook: string;
    isDirect: boolean;
    senderId: string;
}): Promise<boolean> {
    const parsed = parseModelSlashCommand(params.text);
    if (!parsed) return false;

    const mention = { atUserId: !params.isDirect ? params.senderId : null };
    if (parsed.type === 'list') {
        const activeAlias = getActiveModelAlias(params.ctx.config);
        const lines = listConfiguredModels(params.ctx.config)
            .map((item) => `${item.alias === activeAlias ? '•' : ' '} ${item.alias} (${item.provider}) -> ${item.model}`)
            .join('\n');
        const message = lines
            ? `🤖 已配置模型\n\n${lines}`
            : 'ℹ️ 当前没有可用模型配置。';
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

/**
 * Handle incoming DingTalk message
 */
export async function handleMessage(
    data: DingTalkInboundMessage,
    ctx: MessageHandlerContext
): Promise<void> {
    return enqueueConversationTask(data.conversationId, () => handleMessageInternal(data, ctx));
}

async function handleMessageInternal(
    data: DingTalkInboundMessage,
    ctx: MessageHandlerContext
): Promise<void> {
    const { config, dingtalkConfig, log } = ctx;

    // Clean up expired sessions periodically
    cleanupSessions();
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

    const handledModelCommand = await tryHandleModelCommand({
        text: content.text,
        ctx,
        sessionWebhook: data.sessionWebhook,
        isDirect,
        senderId,
    });
    if (handledModelCommand) {
        return;
    }

    let downloadedMediaPath: string | undefined;
    if (content.mediaPath && dingtalkConfig.robotCode) {
        const media = await downloadMedia(dingtalkConfig, content.mediaPath, log);
        if (media) {
            downloadedMediaPath = media.path;
            const mediaNote = `[媒体文件已下载: ${media.path} (${media.mimeType})]`;
            content.text = content.text ? `${content.text}\n\n${mediaNote}` : mediaNote;
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

    // Get or create session for this conversation
    const session = getOrCreateSession(conversationId);

    // Create flush state from session
    let flushState: MemoryFlushState = createMemoryFlushState();
    flushState = { ...flushState, totalTokens: session.totalTokens };

    // Update token count with user input
    flushState = updateTokenCount(flushState, content.text);

    // Reuse shared compaction model
    const compactionModel = await getCompactionModel(config);
    const compactionConfig = config.agent.compaction;

    // Check if we need auto-compaction before processing
    await executeAutoCompact(ctx.agent, session, flushState, compactionModel, compactionConfig, log);

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
        const agentConfig = {
            configurable: { thread_id: session.threadId },
            recursionLimit: config.agent.recursion_limit,
        };

        log.debug(`[DingTalk] Invoking agent with thread_id: ${session.threadId}`);

        let fullResponse = '';

        if (currentCard) {
            // Card mode: use streaming
            log.info('[DingTalk] Starting streamEvents...');

            const eventStream = ctx.agent.streamEvents(
                { messages: [{ role: 'user', content: content.text }] },
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

                        fullResponse += text;

                        // Throttle stream updates to avoid rate limiting
                        scheduleFlush(false);
                    }
                } else if (event.event === 'on_tool_start') {
                    const toolName = event.name;
                    log.info(`[DingTalk] Tool started: ${toolName}`);
                    fullResponse += `\n[调用工具: ${toolName}]\n`;
                    scheduleFlush(false);
                }
            }

            log.info(`[DingTalk] Stream completed, total events: ${eventCount}, response length: ${fullResponse.length}`);

            // Finalize card
            let shouldFallbackToSessionMessage = false;
            if (fullResponse) {
                log.info('[DingTalk] Finalizing AI Card...');
                if (pendingFlush) {
                    clearTimeout(pendingFlush);
                    pendingFlush = null;
                }
                await flushNow(true);

                const cardState = currentCard.state as AICardState;
                if (streamFlushError || cardState !== AICardStatus.FINISHED) {
                    shouldFallbackToSessionMessage = true;
                    log.warn(
                        `[DingTalk] Card finalization incomplete (state=${cardState}), falling back to session markdown reply`
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
                { messages: [{ role: 'user', content: content.text }] },
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

            if (!fullResponse) {
                fullResponse = '抱歉，我没有生成有效的回复。';
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

        // Update token count and message history
        flushState = updateTokenCount(flushState, fullResponse);
        const { HumanMessage, AIMessage } = await import('@langchain/core/messages');
        session.messageHistory.push(new HumanMessage(content.text));
        session.messageHistory.push(new AIMessage(fullResponse));
        session.totalTokens = flushState.totalTokens;
        session.lastUpdated = Date.now();

        // Check auto-compaction after response
        await executeAutoCompact(ctx.agent, session, flushState, compactionModel, compactionConfig, log);

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
    log: Logger
): Promise<MemoryFlushState> {
    log.info('[DingTalk] Executing memory flush...');

    try {
        const result = await agent.invoke(
            {
                messages: [
                    { role: 'system', content: MEMORY_FLUSH_SYSTEM_PROMPT },
                    { role: 'user', content: MEMORY_FLUSH_USER_PROMPT },
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

        return markFlushCompleted(flushState);
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
    log: Logger
): Promise<void> {
    if (!shouldAutoCompact(flushState.totalTokens, compactionConfig)) {
        return;
    }

    log.info('[DingTalk] Auto-compacting context...');

    // First: flush memory to save important info
    if (shouldTriggerMemoryFlush(flushState, compactionConfig)) {
        flushState = await executeMemoryFlush(agent, session, flushState, log);
    }

    // Then: compact context
    try {
        const maxTokens = Math.floor(compactionConfig.context_window * compactionConfig.max_history_share);
        const result = await compactMessages(session.messageHistory, compactionModel, maxTokens);

        session.messageHistory = result.messages;
        session.totalTokens = result.tokensAfter;

        const saved = result.tokensBefore - result.tokensAfter;
        log.info(`[DingTalk] Compaction completed, saved ${formatTokenCount(saved)} tokens`);
    } catch (error) {
        log.error('[DingTalk] Compaction failed:', String(error));
    }
}
