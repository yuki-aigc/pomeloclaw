/**
 * DingTalk Entry Point
 * 
 * Runs the SRE Bot as a DingTalk robot using Stream mode.
 * All CLI mechanisms (memory, compaction, skills, exec) are preserved.
 * 
 * Usage: pnpm dingtalk
 */

import { DWClient, TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.js';
import type { ExecApprovalRequest } from './agent.js';
import { loadConfig } from './config.js';
import {
    getActiveModelAlias,
    getActiveModelName,
    hasModelAlias,
    setActiveModelAlias,
} from './llm.js';
import {
    handleMessage,
    flushSessionsOnShutdown,
    closeSessionResources,
    type Logger,
    type DingTalkInboundMessage,
} from './channels/dingtalk/index.js';
import { sendProactiveMessage } from './channels/dingtalk/client.js';
import { createDingTalkChannelAdapter } from './channels/dingtalk/adapter.js';
import { requestDingTalkExecApproval, withApprovalContext, tryHandleExecApprovalCardCallback } from './channels/dingtalk/approvals.js';
import { GatewayService } from './channels/gateway/index.js';
import type { ChannelInboundMessage } from './channels/gateway/index.js';
import { CronService } from './cron/service.js';
import { setCronService } from './cron/runtime.js';
import { resolveCronStorePath } from './cron/store.js';
import type { CronJob } from './cron/types.js';
import type { RuntimeLogWriter } from './log/runtime.js';

// ANSI terminal colors
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    orange: '\x1b[38;5;208m',
    cyan: '\x1b[36m',
};

// Cache discovered group conversation IDs to avoid noisy duplicate logs.
const seenGroupConversations = new Map<string, string>();
const AUTO_MEMORY_SAVE_JOB_NAME = '系统任务：每日记忆归档(04:00)';
const AUTO_MEMORY_SAVE_JOB_MARKER = '[system:auto-memory-save-4am:v1]';
const AUTO_MEMORY_SAVE_JOB_CRON_EXPR = '0 4 * * *';

function buildAutoMemorySaveJobDescription(): string {
    return `自动创建，请勿删除。${AUTO_MEMORY_SAVE_JOB_MARKER}`;
}

function buildAutoMemorySaveJobPrompt(): string {
    return [
        '请执行每日记忆归档任务。',
        '要求：',
        '1. 回顾最近24小时对话中的关键事实、告警分析、定位结论、处置动作、遗留风险与待办。',
        '2. 调用 memory_save，target 必须是 daily；内容需要结构化且可复盘。',
        '3. 完成后在回复末尾明确输出: memory_saved。',
        '注意：若你没有调用 memory_save 就结束任务，视为失败。',
    ].join('\n');
}

function isAutoMemorySaveJob(job: CronJob): boolean {
    const description = job.description || '';
    if (description.includes(AUTO_MEMORY_SAVE_JOB_MARKER)) {
        return true;
    }
    return job.name === AUTO_MEMORY_SAVE_JOB_NAME;
}

async function ensureAutoMemorySaveJob(params: {
    cronService: CronService;
    config: ReturnType<typeof loadConfig>;
    log: Logger;
}): Promise<void> {
    const { cronService, config, log } = params;
    if (!config.cron.enabled) {
        return;
    }
    if (config.dingtalk?.cron?.autoMemorySaveAt4 === false) {
        return;
    }

    const defaultTarget = config.dingtalk?.cron?.defaultTarget?.trim();
    if (!defaultTarget) {
        log.warn('[Cron] skip auto memory-save(04:00): dingtalk.cron.defaultTarget is empty');
        return;
    }

    const desiredDescription = buildAutoMemorySaveJobDescription();
    const desiredPrompt = buildAutoMemorySaveJobPrompt();
    const desiredTimezone = config.cron.timezone;
    const desiredUseMarkdown = config.dingtalk?.cron?.useMarkdown ?? true;
    const desiredTitle = config.dingtalk?.cron?.title || '每日记忆归档';

    const jobs = await cronService.listJobs();
    const matched = jobs.filter((job) => isAutoMemorySaveJob(job));
    const primary = matched[0];

    if (!primary) {
        const created = await cronService.addJob({
            name: AUTO_MEMORY_SAVE_JOB_NAME,
            description: desiredDescription,
            enabled: true,
            schedule: {
                kind: 'cron',
                expr: AUTO_MEMORY_SAVE_JOB_CRON_EXPR,
                timezone: desiredTimezone,
            },
            payload: {
                message: desiredPrompt,
            },
            delivery: {
                target: defaultTarget,
                title: desiredTitle,
                useMarkdown: desiredUseMarkdown,
            },
        });
        log.info(`[Cron] ensured auto memory-save job created: ${created.id}`);
        return;
    }

    if (matched.length > 1) {
        for (const duplicate of matched.slice(1)) {
            await cronService.deleteJob(duplicate.id);
            log.info(`[Cron] removed duplicate auto memory-save job: ${duplicate.id}`);
        }
    }

    let needsUpdate = false;
    const patch: {
        name?: string;
        description?: string;
        enabled?: boolean;
        schedule?: { kind: 'cron'; expr: string; timezone?: string };
        payload?: { message?: string };
        delivery?: { target?: string; title?: string; useMarkdown?: boolean };
    } = {};

    if (primary.name !== AUTO_MEMORY_SAVE_JOB_NAME) {
        patch.name = AUTO_MEMORY_SAVE_JOB_NAME;
        needsUpdate = true;
    }
    if ((primary.description || '') !== desiredDescription) {
        patch.description = desiredDescription;
        needsUpdate = true;
    }
    if (!primary.enabled) {
        patch.enabled = true;
        needsUpdate = true;
    }
    if (
        primary.schedule.kind !== 'cron'
        || primary.schedule.expr !== AUTO_MEMORY_SAVE_JOB_CRON_EXPR
        || (primary.schedule.timezone || undefined) !== (desiredTimezone || undefined)
    ) {
        patch.schedule = {
            kind: 'cron',
            expr: AUTO_MEMORY_SAVE_JOB_CRON_EXPR,
            timezone: desiredTimezone,
        };
        needsUpdate = true;
    }
    if ((primary.payload.message || '').trim() !== desiredPrompt) {
        patch.payload = { message: desiredPrompt };
        needsUpdate = true;
    }

    const shouldPatchDelivery =
        (primary.delivery.target || '').trim() !== defaultTarget
        || (primary.delivery.title || '') !== desiredTitle
        || (primary.delivery.useMarkdown ?? true) !== desiredUseMarkdown;
    if (shouldPatchDelivery) {
        patch.delivery = {
            target: defaultTarget,
            title: desiredTitle,
            useMarkdown: desiredUseMarkdown,
        };
        needsUpdate = true;
    }

    if (needsUpdate) {
        const updated = await cronService.updateJob(primary.id, patch);
        log.info(`[Cron] ensured auto memory-save job updated: ${updated.id}`);
    } else {
        log.info(`[Cron] ensured auto memory-save job exists: ${primary.id}`);
    }
}

/**
 * Create logger for DingTalk channel
 */
function createLogger(debug: boolean = false, logWriter?: RuntimeLogWriter): Logger {
    return {
        debug: (message: string, ...args: unknown[]) => {
            logWriter?.write('DEBUG', message, args);
            if (debug) {
                console.log(`${colors.gray}${message}${colors.reset}`, ...args);
            }
        },
        info: (message: string, ...args: unknown[]) => {
            logWriter?.write('INFO', message, args);
            console.log(`${colors.cyan}${message}${colors.reset}`, ...args);
        },
        warn: (message: string, ...args: unknown[]) => {
            logWriter?.write('WARN', message, args);
            console.warn(`${colors.yellow}${message}${colors.reset}`, ...args);
        },
        error: (message: string, ...args: unknown[]) => {
            logWriter?.write('ERROR', message, args);
            console.error(`${colors.red}${message}${colors.reset}`, ...args);
        },
    };
}

/**
 * Print startup header
 */
function printHeader(config: ReturnType<typeof loadConfig>) {
    const model = getActiveModelName(config);

    const o = colors.orange;
    const r = colors.reset;
    const g = colors.gray;
    const b = colors.bright;
    const rd = colors.red;
    const c = colors.cyan;

    console.log();
    console.log(`     ${o}▄▄▄▄▄${r}        ${b}SRE Bot${r} ${g}v1.0.0${r} ${c}[DingTalk Mode]${r}`);
    console.log(`   ${o}█ ${r}●   ●${o} █      ${g}${model}${r}`);
    console.log(`   ${o}█ ${rd}      ${o}█      ${g}Memory & Skills Enabled${r}`);
    console.log(`    ${o}▀▀▀▀▀▀▀${r}       ${g}Stream Mode (No Public IP Required)${r}`);
    console.log(`     ${g}▀   ▀${r}`);
    console.log();
}

function extractTextContent(content: unknown): string {
    if (typeof content === 'string') {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return '';
    }
    const blocks: string[] = [];
    for (const block of content) {
        if (typeof block === 'string') {
            blocks.push(block);
            continue;
        }
        if (!block || typeof block !== 'object') {
            continue;
        }
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
            blocks.push(text);
        }
    }
    return blocks.join('\n').trim();
}

function extractAgentResponseText(result: unknown): string {
    if (!result || typeof result !== 'object') {
        return '';
    }
    const messages = (result as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) {
        return '';
    }
    const lastMessage = messages[messages.length - 1] as { content?: unknown } | undefined;
    if (!lastMessage) {
        return '';
    }
    return extractTextContent(lastMessage.content);
}

function buildCronDeliveryTarget(job: CronJob, config: ReturnType<typeof loadConfig>): string | undefined {
    const fromJob = job.delivery.target?.trim();
    if (fromJob) return fromJob;
    const fromConfig = config.dingtalk?.cron?.defaultTarget?.trim();
    if (fromConfig) return fromConfig;
    return undefined;
}

function buildGatewayInboundFromDingTalk(params: {
    data: DingTalkInboundMessage;
    messageIdFromHeader?: string;
}): ChannelInboundMessage {
    const { data, messageIdFromHeader } = params;
    const senderId = data.senderStaffId || data.senderId;
    const senderName = data.senderNick || 'Unknown';
    const isDirect = data.conversationType === '1';
    const messageId = data.msgId || messageIdFromHeader || `dingtalk-${Date.now()}`;
    const fallbackText = data.text?.content?.trim() || '';
    const text = fallbackText
        || data.content?.recognition?.trim()
        || (data.msgtype ? `[${data.msgtype}]` : '[消息]');

    return {
        channel: 'dingtalk',
        messageId,
        idempotencyKey: data.msgId || messageIdFromHeader || messageId,
        timestamp: data.createAt || Date.now(),
        conversationId: data.conversationId,
        conversationTitle: data.conversationTitle,
        isDirect,
        senderId,
        senderName,
        sessionWebhook: data.sessionWebhook,
        text,
        messageType: data.msgtype || 'text',
        raw: data,
    };
}

export async function startDingTalkService(options?: {
    registerSignalHandlers?: boolean;
    exitOnShutdown?: boolean;
    logWriter?: RuntimeLogWriter;
}): Promise<{ shutdown: () => Promise<void> }> {
    const registerSignalHandlers = options?.registerSignalHandlers ?? false;
    const exitOnShutdown = options?.exitOnShutdown ?? false;
    const config = loadConfig();
    let cleanup: (() => Promise<void>) | null = null;
    let cronService: CronService | null = null;
    let gateway: GatewayService | null = null;

    // Validate DingTalk configuration
    if (!config.dingtalk) {
        throw new Error('DingTalk configuration not found in config.json');
    }

    const dingtalkConfig = config.dingtalk;

    if (!dingtalkConfig.clientId || !dingtalkConfig.clientSecret) {
        throw new Error('DingTalk clientId and clientSecret are required');
    }

    if (dingtalkConfig.clientId === 'YOUR_DINGTALK_APP_KEY') {
        throw new Error('Please replace placeholder DingTalk credentials in config.json');
    }

    printHeader(config);

    // Create logger
    const log = createLogger(dingtalkConfig.debug, options?.logWriter);

    // Create agent
    log.info('[DingTalk] Initializing agent...');
    const execApprovalPrompt = async (request: ExecApprovalRequest) =>
        requestDingTalkExecApproval(request);
    const initialAgentContext = await createAgent(config, {
        execApprovalPrompt,
        runtimeChannel: 'dingtalk',
    });
    cleanup = initialAgentContext.cleanup;
    let currentAgent = initialAgentContext.agent;
    log.info('[DingTalk] Agent initialized successfully');

    // Create DingTalk Stream client
    log.info('[DingTalk] Connecting to DingTalk Stream...');

    const client = new DWClient({
        clientId: dingtalkConfig.clientId,
        clientSecret: dingtalkConfig.clientSecret,
        debug: dingtalkConfig.debug || false,
        keepAlive: true,
    });

    // Message handler context
    const ctx = {
        agent: currentAgent,
        config,
        dingtalkConfig,
        log,
        switchModel: async (alias: string) => {
            const trimmedAlias = alias.trim();
            if (!trimmedAlias) {
                throw new Error('模型别名不能为空');
            }
            if (!hasModelAlias(config, trimmedAlias)) {
                throw new Error(`未找到模型别名: ${trimmedAlias}`);
            }

            const previousAlias = getActiveModelAlias(config);
            if (previousAlias === trimmedAlias) {
                return {
                    alias: trimmedAlias,
                    model: getActiveModelName(config),
                };
            }

            let nextCleanup: (() => Promise<void>) | null = null;
            try {
                setActiveModelAlias(config, trimmedAlias);
                const nextAgentContext = await createAgent(config, {
                    execApprovalPrompt,
                    runtimeChannel: 'dingtalk',
                });
                nextCleanup = nextAgentContext.cleanup;

                const oldCleanup = cleanup;
                currentAgent = nextAgentContext.agent;
                ctx.agent = nextAgentContext.agent;
                cleanup = nextAgentContext.cleanup;

                if (oldCleanup) {
                    try {
                        await oldCleanup();
                    } catch (error) {
                        log.warn('[DingTalk] previous agent cleanup failed:', error instanceof Error ? error.message : String(error));
                    }
                }

                return {
                    alias: trimmedAlias,
                    model: getActiveModelName(config),
                };
            } catch (error) {
                if (nextCleanup) {
                    try {
                        await nextCleanup();
                    } catch {
                        // ignore cleanup errors when switch fails
                    }
                }
                try {
                    setActiveModelAlias(config, previousAlias);
                } catch {
                    // ignore rollback errors and bubble up original error
                }
                throw error;
            }
        },
    };

    cronService = new CronService({
        enabled: config.cron.enabled,
        timezone: config.cron.timezone,
        storePath: resolveCronStorePath(config.cron.store),
        runLogPath: config.cron.runLog,
        defaultDelivery: {
            target: dingtalkConfig.cron?.defaultTarget,
            useMarkdown: dingtalkConfig.cron?.useMarkdown,
            title: dingtalkConfig.cron?.title,
        },
        logger: {
            debug: (message: string, ...args: unknown[]) => log.debug(message, ...args),
            info: (message: string, ...args: unknown[]) => log.info(message, ...args),
            warn: (message: string, ...args: unknown[]) => log.warn(message, ...args),
            error: (message: string, ...args: unknown[]) => log.error(message, ...args),
        },
        runJob: async (job) => {
            const target = buildCronDeliveryTarget(job, config);
            if (!target) {
                return {
                    status: 'error',
                    error: `任务 ${job.id} 未配置发送目标；请设置 cron_job_add.target 或 config.dingtalk.cron.defaultTarget`,
                };
            }

            const threadId = `cron-${job.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const invokeResult = await currentAgent.invoke(
                {
                    messages: [
                        {
                            role: 'user',
                            content: `[定时任务 ${job.name}] ${job.payload.message}`,
                        },
                    ],
                },
                {
                    configurable: { thread_id: threadId },
                    recursionLimit: config.agent.recursion_limit,
                }
            );

            const text = extractAgentResponseText(invokeResult) || '任务已执行，但未返回文本结果。';
            const useMarkdown = job.delivery.useMarkdown ?? dingtalkConfig.cron?.useMarkdown ?? true;
            const title = job.delivery.title || dingtalkConfig.cron?.title || `定时任务: ${job.name}`;
            const outboundText = useMarkdown
                ? `## ${job.name}\n\n${text}`
                : `【${job.name}】\n${text}`;

            await sendProactiveMessage(
                dingtalkConfig,
                target,
                outboundText,
                {
                    title,
                    useMarkdown,
                },
                log
            );

            return {
                status: 'ok',
                summary: text.slice(0, 300),
            };
        },
    });
    await cronService.start();
    await ensureAutoMemorySaveJob({
        cronService,
        config,
        log,
    }).catch((error) => {
        log.warn('[Cron] ensure auto memory-save job failed:', error instanceof Error ? error.message : String(error));
    });
    setCronService(cronService);

    gateway = new GatewayService({
        onProcessInbound: async (message) => {
            if (message.channel !== 'dingtalk') {
                return { skipReply: true };
            }
            const raw = message.raw;
            if (!raw || typeof raw !== 'object') {
                throw new Error('DingTalk inbound missing raw payload');
            }
            const data = raw as DingTalkInboundMessage;
            const isDirect = data.conversationType === '1';
            const senderId = data.senderStaffId || data.senderId;
            const senderName = data.senderNick || 'Unknown';
            await withApprovalContext(
                {
                    dingtalkConfig: ctx.dingtalkConfig,
                    conversationId: data.conversationId,
                    isDirect,
                    senderId,
                    senderName,
                    sessionWebhook: data.sessionWebhook,
                    log: ctx.log,
                },
                () => handleMessage(data, ctx)
            );
            return { skipReply: true };
        },
        logger: {
            debug: (message: string, ...args: unknown[]) => log.debug(message, ...args),
            info: (message: string, ...args: unknown[]) => log.info(message, ...args),
            warn: (message: string, ...args: unknown[]) => log.warn(message, ...args),
            error: (message: string, ...args: unknown[]) => log.error(message, ...args),
        },
    });
    const dingtalkAdapter = createDingTalkChannelAdapter({ config: dingtalkConfig, log });
    gateway.registerAdapter(dingtalkAdapter);
    await gateway.start();

    // Register message callback
    client.registerCallbackListener(TOPIC_ROBOT, async (res: { headers?: { messageId?: string }; data: string }) => {
        const messageId = res.headers?.messageId;

        try {
            // Acknowledge message receipt immediately
            if (messageId) {
                client.socketCallBackResponse(messageId, { success: true });
            }

            // Parse and handle message
            const data = JSON.parse(res.data) as DingTalkInboundMessage;
            const isDirect = data.conversationType === '1';
            const senderId = data.senderStaffId || data.senderId;
            const senderName = data.senderNick || 'Unknown';
            if (!isDirect) {
                const conversationId = data.conversationId || '';
                const conversationTitle = (data.conversationTitle || '').trim() || '(未命名群)';
                const previousTitle = seenGroupConversations.get(conversationId);
                if (!previousTitle || previousTitle !== conversationTitle) {
                    seenGroupConversations.set(conversationId, conversationTitle);
                    log.info(`[DingTalk] 群会话映射: ${conversationTitle} -> ${conversationId}`);
                }
            }
            const dispatchResult = await dingtalkAdapter.handleInbound(
                buildGatewayInboundFromDingTalk({
                    data,
                    messageIdFromHeader: messageId,
                })
            );
            if (dispatchResult.status === 'error') {
                log.error(`[DingTalk] Gateway dispatch failed: ${dispatchResult.reason || '(unknown)'}`);
            } else if (dispatchResult.status === 'duplicate') {
                log.debug('[DingTalk] Duplicate inbound message skipped by gateway');
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(`[DingTalk] Error processing message: ${errorMessage}`);
        }
    });

    // Card interaction callback (button approvals)
    client.registerCallbackListener(TOPIC_CARD, async (res: { headers?: { messageId?: string }; data: string }) => {
        const messageId = res.headers?.messageId;

        try {
            if (messageId) {
                client.socketCallBackResponse(messageId, { success: true });
            }

            const payload = JSON.parse(res.data) as Record<string, unknown>;
            log.debug?.(`[DingTalk] Card callback payload: ${JSON.stringify(payload)}`);
            await tryHandleExecApprovalCardCallback({ payload, log });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(`[DingTalk] Error processing card callback: ${errorMessage}`);
        }
    });

    // Connect to DingTalk
    await client.connect();
    log.info('[DingTalk] Connected! Bot is now online and listening for messages.');
    console.log();
    console.log(`${colors.gray}Press Ctrl+C to stop the bot.${colors.reset}`);
    console.log();

    // Handle graceful shutdown
    let isShuttingDown = false;

    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        console.log();
        log.info('[DingTalk] Shutting down...');

        if (gateway) {
            try {
                await gateway.stop();
            } catch (error) {
                log.warn('[DingTalk] gateway stop failed:', error instanceof Error ? error.message : String(error));
            }
        }

        if (cronService) {
            try {
                await cronService.stop();
            } catch (error) {
                log.warn('[DingTalk] cron service stop failed:', error instanceof Error ? error.message : String(error));
            }
            setCronService(null);
        }

        try {
            const shutdownResult = await flushSessionsOnShutdown({
                agent: currentAgent,
                config,
                log,
                drainTimeoutMs: 15000,
                flushTimeoutMs: 30000,
            });
            log.info(
                `[DingTalk] Shutdown memory flush summary: drained=${shutdownResult.drained} ` +
                `pending=${shutdownResult.drainedConversations} sessions=${shutdownResult.sessionsTotal} ` +
                `flushed=${shutdownResult.sessionsFlushed} flush_failed=${shutdownResult.sessionsFlushFailed} ` +
                `persisted=${shutdownResult.sessionsPersisted}`
            );
        } catch (error) {
            log.warn('[DingTalk] Shutdown memory flush failed:', error instanceof Error ? error.message : String(error));
        }

        // Note: dingtalk-stream doesn't have a disconnect method,
        // the process will exit and close the connection
        try {
            await closeSessionResources(log);
        } catch (error) {
            log.warn('[DingTalk] session resource cleanup failed:', error instanceof Error ? error.message : String(error));
        }

        if (cleanup) {
            try {
                await cleanup();
            } catch (error) {
                log.warn('[DingTalk] MCP cleanup failed:', error instanceof Error ? error.message : String(error));
            }
        }

        console.log(`${colors.gray}Goodbye! 👋${colors.reset}`);
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
    startDingTalkService({
        registerSignalHandlers: true,
        exitOnShutdown: true,
    }).catch((error) => {
        console.error(`${colors.red}Fatal error:${colors.reset}`, error);
        process.exit(1);
    });
}
