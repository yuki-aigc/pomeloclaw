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
import { createAgent } from './agent.js';
import type { ExecApprovalRequest } from './agent.js';
import { loadConfig } from './config.js';
import {
    getActiveModelAlias,
    getActiveModelName,
    hasModelAlias,
    setActiveModelAlias,
} from './llm.js';
import { handleMessage, type Logger, type DingTalkInboundMessage } from './channels/dingtalk/index.js';
import { sendProactiveMessage } from './channels/dingtalk/client.js';
import { requestDingTalkExecApproval, withApprovalContext, tryHandleExecApprovalCardCallback } from './channels/dingtalk/approvals.js';
import { CronService } from './cron/service.js';
import { setCronService } from './cron/runtime.js';
import { resolveCronStorePath } from './cron/store.js';
import type { CronJob } from './cron/types.js';

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

/**
 * Create logger for DingTalk channel
 */
function createLogger(debug: boolean = false): Logger {
    return {
        debug: (message: string, ...args: unknown[]) => {
            if (debug) {
                console.log(`${colors.gray}${message}${colors.reset}`, ...args);
            }
        },
        info: (message: string, ...args: unknown[]) => {
            console.log(`${colors.cyan}${message}${colors.reset}`, ...args);
        },
        warn: (message: string, ...args: unknown[]) => {
            console.warn(`${colors.yellow}${message}${colors.reset}`, ...args);
        },
        error: (message: string, ...args: unknown[]) => {
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

async function main() {
    const config = loadConfig();
    let cleanup: (() => Promise<void>) | null = null;
    let cronService: CronService | null = null;

    // Validate DingTalk configuration
    if (!config.dingtalk) {
        console.error(`${colors.red}Error: DingTalk configuration not found in config.json${colors.reset}`);
        console.error(`${colors.gray}Please add a "dingtalk" section with clientId and clientSecret.${colors.reset}`);
        process.exit(1);
    }

    const dingtalkConfig = config.dingtalk;

    if (!dingtalkConfig.clientId || !dingtalkConfig.clientSecret) {
        console.error(`${colors.red}Error: DingTalk clientId and clientSecret are required${colors.reset}`);
        console.error(`${colors.gray}Please configure these in config.json under "dingtalk" section.${colors.reset}`);
        process.exit(1);
    }

    if (dingtalkConfig.clientId === 'YOUR_DINGTALK_APP_KEY') {
        console.error(`${colors.red}Error: Please replace placeholder DingTalk credentials in config.json${colors.reset}`);
        console.error(`${colors.gray}Set your actual clientId (AppKey) and clientSecret (AppSecret).${colors.reset}`);
        process.exit(1);
    }

    printHeader(config);

    // Create logger
    const log = createLogger(dingtalkConfig.debug);

    // Create agent
    log.info('[DingTalk] Initializing agent...');
    const execApprovalPrompt = async (request: ExecApprovalRequest) =>
        requestDingTalkExecApproval(request);
    const initialAgentContext = await createAgent(config, { execApprovalPrompt });
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
                const nextAgentContext = await createAgent(config, { execApprovalPrompt });
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
    setCronService(cronService);

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

        if (cronService) {
            try {
                await cronService.stop();
            } catch (error) {
                log.warn('[DingTalk] cron service stop failed:', error instanceof Error ? error.message : String(error));
            }
            setCronService(null);
        }

        // Note: dingtalk-stream doesn't have a disconnect method,
        // the process will exit and close the connection
        if (cleanup) {
            try {
                await cleanup();
            } catch (error) {
                log.warn('[DingTalk] MCP cleanup failed:', error instanceof Error ? error.message : String(error));
            }
        }

        console.log(`${colors.gray}Goodbye! 👋${colors.reset}`);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error(`${colors.red}Fatal error:${colors.reset}`, error);
    process.exit(1);
});
