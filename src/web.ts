import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RuntimeAgent } from './agent.js';
import { loadConfig } from './config.js';
import { ConversationRuntime } from './conversation/runtime.js';
import { createChatModel, getActiveModelAlias, getActiveModelEntry, listConfiguredModels } from './llm.js';
import { createWebChannelAdapter, type WebLogger, type WebChannelAdapter } from './channels/web/index.js';
import { GatewayService } from './channels/gateway/index.js';
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
import { buildAttachmentMediaContext } from './channels/media-context.js';
import {
    createRuntimeConsoleLogger,
    printChannelHeader,
    terminalColors as colors,
    toGatewayLogger,
} from './channels/runtime-entry.js';
import { formatTokenCount, getCompactionHardContextBudget, getContextUsageInfo, getEffectiveAutoCompactThreshold } from './compaction/index.js';
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
import { createSkillDirectoryMonitor, executeSkillSlashCommand } from './skills/index.js';

const conversationQueue = new Map<string, Promise<void>>();

interface WebConversationRuntimeState {
    threadId: string;
    flushState: MemoryFlushState;
    totalInputTokens: number;
    totalOutputTokens: number;
    lastUpdatedAt: number;
}

type WebSlashCommand =
    | { type: 'list_models' }
    | { type: 'status' }
    | { type: 'switch_model'; alias: string }
    | { type: 'voice'; mode: 'status' | 'toggle'; enabled?: boolean }
    | { type: 'help' }
    | { type: 'unknown'; command: string };

function composeInboundWebText(text: string, mediaContext: string | null): string {
    const normalizedText = text.trim();
    const normalizedMedia = mediaContext?.trim() || '';
    if (normalizedText && normalizedMedia) {
        return `${normalizedText}\n\n${normalizedMedia}`;
    }
    if (normalizedText) {
        return normalizedText;
    }
    if (normalizedMedia) {
        return `请结合以下附件内容进行处理。\n\n${normalizedMedia}`;
    }
    return '';
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

function parseWebSlashCommand(input: string): WebSlashCommand | null {
    const text = input.trim();
    if (!text.startsWith('/')) {
        return null;
    }
    if (text === '/models') {
        return { type: 'list_models' };
    }
    if (text === '/status') {
        return { type: 'status' };
    }
    if (text === '/model') {
        return { type: 'switch_model', alias: '' };
    }
    if (text.startsWith('/model ')) {
        return { type: 'switch_model', alias: text.slice('/model'.length).trim() };
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

function buildWebHelpMessage(currentModelAlias: string): string {
    return [
        '## 命令帮助',
        '',
        '- `/status` 查看当前会话状态',
        '- `/models` 查看可用模型列表',
        '- `/model <别名>` 切换模型（例如 `/model qwen`）',
        '- `/skills` 查看已安装技能',
        '- `/skill-install <来源>` 远程或本地安装技能',
        '- `/skill-remove <名称>` 删除已安装技能',
        '- `/skill-reload` 重新加载技能索引',
        '- `/voice` / `/voice on` / `/voice off` 在 Web 渠道暂不支持',
        '- `/help` 或 `/?` 查看本帮助',
        '',
        `当前模型：\`${currentModelAlias}\``,
    ].join('\n');
}

function buildWebStatusMessage(params: {
    config: ReturnType<typeof loadConfig>;
    state: WebConversationRuntimeState;
}): string {
    const { config, state } = params;
    const activeAlias = getActiveModelAlias(config);
    const activeModel = getActiveModelEntry(config);
    const contextConfig = config.agent.compaction;
    const effectiveThreshold = getEffectiveAutoCompactThreshold(contextConfig);
    const hardBudget = getCompactionHardContextBudget(contextConfig);
    const appVersion = process.env.npm_package_version || '1.0.0';
    const contextRatio = (state.flushState.totalTokens / contextConfig.context_window) * 100;
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
        `- Token：输入 ${formatTokenCount(state.totalInputTokens)} / 输出 ${formatTokenCount(state.totalOutputTokens)}`,
        `- 上下文：${formatTokenCount(state.flushState.totalTokens)} / ${formatTokenCount(contextConfig.context_window)}（${contextPercent}%）`,
        `- 压缩次数：${state.flushState.flushCount}`,
        `- 会话：\`${state.threadId}\``,
        `- 最近更新：${formatRelativeTime(state.lastUpdatedAt)}`,
        '- 运行模式：web（think=low，queue=collect depth=0）',
        '',
        getContextUsageInfo(state.flushState.totalTokens, contextConfig),
        `自动压缩阈值：${formatTokenCount(effectiveThreshold)}（hard budget: ${formatTokenCount(hardBudget)}）`,
    ].join('\n');
}

async function sendImmediateWebReply(params: {
    adapter: WebChannelAdapter;
    inbound: {
        messageId: string;
        conversationId: string;
    } & Parameters<WebChannelAdapter['sendStreamEvent']>[0]['inbound'];
    text: string;
}): Promise<void> {
    await params.adapter.sendStreamEvent({
        inbound: params.inbound,
        payload: {
            type: 'reply_start',
            sourceMessageId: params.inbound.messageId,
            request_id: params.inbound.messageId,
            conversationId: params.inbound.conversationId,
            session_id: params.inbound.conversationId,
            timestamp: Date.now(),
        },
    });
    await params.adapter.sendStreamEvent({
        inbound: params.inbound,
        payload: {
            type: 'reply_final',
            sourceMessageId: params.inbound.messageId,
            request_id: params.inbound.messageId,
            conversationId: params.inbound.conversationId,
            session_id: params.inbound.conversationId,
            text: params.text,
            attachments: [],
            finishReason: 'completed',
            timestamp: Date.now(),
        },
    });
}

async function tryHandleWebSlashCommand(params: {
    text: string;
    config: ReturnType<typeof loadConfig>;
    state: WebConversationRuntimeState;
    conversationRuntime: ConversationRuntime;
    onModelChanged: () => void;
}): Promise<string | null> {
    const parsed = parseWebSlashCommand(params.text);
    if (!parsed) {
        return null;
    }

    if (parsed.type === 'status') {
        return buildWebStatusMessage({
            config: params.config,
            state: params.state,
        });
    }

    if (parsed.type === 'list_models') {
        const activeAlias = getActiveModelAlias(params.config);
        const lines = listConfiguredModels(params.config)
            .map((item) => `- ${item.alias === activeAlias ? '✅' : '▫️'} \`${item.alias}\` (${item.provider}) → ${item.model}`)
            .join('\n');
        return lines
            ? `## 已配置模型\n\n${lines}\n\n当前模型：\`${activeAlias}\``
            : '## 已配置模型\n\n当前没有可用模型配置。';
    }

    if (parsed.type === 'help') {
        return buildWebHelpMessage(getActiveModelAlias(params.config));
    }

    if (parsed.type === 'voice') {
        return parsed.mode === 'toggle'
            ? 'ℹ️ Web 渠道当前不支持 `/voice on` / `/voice off`。该命令仅在 DingTalk 语音输入链路下生效。'
            : 'ℹ️ Web 渠道当前不支持 `/voice`。该命令仅在 DingTalk 语音输入链路下生效。';
    }

    if (parsed.type === 'unknown') {
        return `❓ 未知命令：\`${parsed.command}\`\n\n发送 \`/help\` 查看可用命令。`;
    }

    if (!parsed.alias) {
        return `ℹ️ 用法: /model <模型别名>\n当前模型: ${getActiveModelAlias(params.config)}`;
    }

    if (parsed.alias === getActiveModelAlias(params.config)) {
        return `ℹ️ 当前已在使用模型: ${parsed.alias}`;
    }

    try {
        const result = await params.conversationRuntime.switchModel(parsed.alias);
        params.onModelChanged();
        return `✅ 已切换模型: ${result.alias} (${result.model})`;
    } catch (error) {
        return `❌ 切换模型失败: ${error instanceof Error ? error.message : String(error)}`;
    }
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
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastUpdatedAt: Date.now(),
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
    agent: RuntimeAgent;
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
    agent: RuntimeAgent;
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
    const conversationRuntime = new ConversationRuntime({
        runtimeChannel: 'web',
        config,
    });
    await conversationRuntime.initialize();

    let currentAgent = conversationRuntime.getAgent();
    let gateway: GatewayService | null = null;
    let webAdapter: WebChannelAdapter | null = null;
    let isShuttingDown = false;
    const conversationStates = new Map<string, WebConversationRuntimeState>();
    const memoryWorkspacePath = resolve(process.cwd(), config.agent.workspace);
    const skillsPath = resolve(process.cwd(), config.agent.skills_dir);
    let compactionModelPromise: Promise<BaseChatModel> | null = null;
    const skillMonitor = createSkillDirectoryMonitor({
        skillsDir: skillsPath,
        logger: log,
        onChange: () => {
            conversationRuntime.requestReload();
            log.info('[Web] Skills changed on disk, reload scheduled for next request.');
        },
    });

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
                await conversationRuntime.reloadIfNeeded();
                currentAgent = conversationRuntime.getAgent();
                const conversationState = getOrCreateConversationState(conversationStates, message.conversationId);
                conversationState.lastUpdatedAt = Date.now();

                const slashResponse = await tryHandleWebSlashCommand({
                    text: message.text,
                    config,
                    state: conversationState,
                    conversationRuntime,
                    onModelChanged: () => {
                        currentAgent = conversationRuntime.getAgent();
                    },
                });
                if (slashResponse) {
                    await sendImmediateWebReply({
                        adapter,
                        inbound: message,
                        text: slashResponse,
                    });
                    return;
                }

                const mediaContext = await buildAttachmentMediaContext({
                    config,
                    attachments: message.attachments || [],
                    log,
                });
                const userText = composeInboundWebText(message.text, mediaContext);
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

                const skillCommand = await executeSkillSlashCommand({
                    input: userText,
                    skillsDir: skillsPath,
                    reloadAgent: async () => {
                        await conversationRuntime.reloadAgent();
                        currentAgent = conversationRuntime.getAgent();
                    },
                });
                if (skillCommand.handled) {
                    await sendImmediateWebReply({
                        adapter,
                        inbound: message,
                        text: skillCommand.response || '已处理技能命令。',
                    });
                    return;
                }

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
                        attachmentCount: message.attachments?.length || 0,
                    },
                });
                const tokensBeforeInput = conversationState.flushState.totalTokens;
                conversationState.flushState = await updateTokenCountWithModel(
                    conversationState.flushState,
                    userText,
                    compactionModel,
                    config.agent.compaction,
                );
                conversationState.totalInputTokens += Math.max(0, conversationState.flushState.totalTokens - tokensBeforeInput);

                const threadId = conversationState.threadId;
                const invocationMessages = await conversationRuntime.buildBootstrapMessages({
                    threadId,
                    workspacePath: memoryWorkspacePath,
                    scopeKey: scope.key,
                });

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
                    const tokensBeforeOutput = conversationState.flushState.totalTokens;
                    conversationState.flushState = await updateTokenCountWithModel(
                        conversationState.flushState,
                        fullResponse,
                        compactionModel,
                        config.agent.compaction,
                    );
                    conversationState.totalOutputTokens += Math.max(0, conversationState.flushState.totalTokens - tokensBeforeOutput);
                    conversationState.lastUpdatedAt = Date.now();
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

        skillMonitor.close();

        try {
            await conversationRuntime.close();
        } catch (error) {
            log.warn('[Web] MCP cleanup failed:', error instanceof Error ? error.message : String(error));
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
