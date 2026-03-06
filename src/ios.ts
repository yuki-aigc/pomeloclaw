import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { ConversationRuntime } from './conversation/runtime.js';
import { createIOSChannelAdapter } from './channels/ios/index.js';
import type { IOSLogger } from './channels/ios/index.js';
import { GatewayService } from './channels/gateway/index.js';
import { CronService } from './cron/service.js';
import { getCronService, setCronService } from './cron/runtime.js';
import { resolveCronStorePath } from './cron/store.js';
import type { CronJob } from './cron/types.js';
import type { RuntimeLogWriter } from './log/runtime.js';
import { resolveMemoryScope } from './middleware/memory-scope.js';
import {
    createRuntimeConsoleLogger,
    extractAgentResponseText,
    printChannelHeader,
    terminalColors as colors,
    toGatewayLogger,
} from './channels/runtime-entry.js';
import { createSkillDirectoryMonitor, executeSkillSlashCommand } from './skills/index.js';

function buildCronDeliveryTarget(job: CronJob, config: ReturnType<typeof loadConfig>): string | undefined {
    const fromJob = job.delivery.target?.trim();
    if (fromJob) return fromJob;
    const fromConfig = config.ios?.cron?.defaultTarget?.trim();
    if (fromConfig) return fromConfig;
    return undefined;
}

function resolveIOSCronStorePath(config: ReturnType<typeof loadConfig>): string {
    const fromConfig = config.ios?.cron?.store?.trim();
    if (fromConfig) {
        return resolveCronStorePath(fromConfig);
    }
    return resolveCronStorePath('./workspace/cron/ios-jobs.json');
}

function resolveIOSCronRunLogPath(config: ReturnType<typeof loadConfig>): string {
    return config.ios?.cron?.runLog?.trim() || './workspace/cron/ios-runs.jsonl';
}

export async function startIOSService(options?: {
    registerSignalHandlers?: boolean;
    exitOnShutdown?: boolean;
    logWriter?: RuntimeLogWriter;
}): Promise<{ shutdown: () => Promise<void> }> {
    const registerSignalHandlers = options?.registerSignalHandlers ?? false;
    const exitOnShutdown = options?.exitOnShutdown ?? false;
    const config = loadConfig();

    if (!config.ios) {
        throw new Error('iOS configuration not found in config.json');
    }
    if (!config.ios.enabled) {
        throw new Error('iOS channel is disabled (config.ios.enabled=false)');
    }

    const iosConfig = config.ios;
    const log: IOSLogger = createRuntimeConsoleLogger({
        debug: iosConfig.debug,
        logWriter: options?.logWriter,
    });

    printChannelHeader({
        config,
        modeLabel: 'iOS Mode',
        statusLines: ['WebSocket Gateway Enabled'],
    });

    log.info('[iOS] Initializing agent...');
    const conversationRuntime = new ConversationRuntime({
        runtimeChannel: 'ios',
        config,
    });
    await conversationRuntime.initialize();

    let currentAgent = conversationRuntime.getAgent();
    let gateway: GatewayService | null = null;
    let cronService: CronService | null = null;
    const memoryWorkspacePath = resolve(process.cwd(), config.agent.workspace);
    const skillsPath = resolve(process.cwd(), config.agent.skills_dir);
    const skillMonitor = createSkillDirectoryMonitor({
        skillsDir: skillsPath,
        logger: log,
        onChange: () => {
            conversationRuntime.requestReload();
            log.info('[iOS] Skills changed on disk, reload scheduled for next request.');
        },
    });

    gateway = new GatewayService({
        onProcessInbound: async (message) => {
            if (message.channel !== 'ios') {
                return { skipReply: true };
            }

            await conversationRuntime.reloadIfNeeded();
            currentAgent = conversationRuntime.getAgent();

            const userText = message.text.trim();
            if (!userText) {
                return {
                    reply: {
                        text: '收到空消息，无法处理。',
                    },
                };
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
                return {
                    reply: {
                        text: skillCommand.response || '已处理技能命令。',
                        useMarkdown: false,
                    },
                };
            }

            const threadId = `ios-${message.conversationId}`;
            const scope = resolveMemoryScope(config.agent.memory.session_isolation);
            const invocationMessages = await conversationRuntime.buildBootstrapMessages({
                threadId,
                workspacePath: memoryWorkspacePath,
                scopeKey: scope.key,
            });
            invocationMessages.push({
                role: 'user',
                content: userText,
            });
            const invokeResult = await currentAgent.invoke(
                {
                    messages: invocationMessages,
                },
                {
                    configurable: { thread_id: threadId },
                    recursionLimit: config.agent.recursion_limit,
                }
            );

            const replyText = extractAgentResponseText(invokeResult) || '已处理，但没有可返回的文本结果。';
            return {
                reply: {
                    text: replyText,
                    useMarkdown: false,
                },
            };
        },
        logger: toGatewayLogger(log),
    });

    const iosAdapter = createIOSChannelAdapter({ config: iosConfig, log });
    gateway.registerAdapter(iosAdapter);
    await gateway.start();

    cronService = new CronService({
        enabled: config.cron.enabled,
        timezone: config.cron.timezone,
        storePath: resolveIOSCronStorePath(config),
        runLogPath: resolveIOSCronRunLogPath(config),
        defaultDelivery: {
            channel: 'ios',
            target: iosConfig.cron?.defaultTarget,
            useMarkdown: iosConfig.cron?.useMarkdown,
            title: iosConfig.cron?.title,
        },
        logger: toGatewayLogger(log),
        runJob: async (job) => {
            const deliveryChannel = job.delivery.channel?.trim().toLowerCase() || 'ios';
            if (deliveryChannel !== 'ios') {
                return {
                    status: 'skipped',
                    error: `任务 ${job.id} 配置 channel=${deliveryChannel}，当前实例仅处理 ios`,
                };
            }

            const target = buildCronDeliveryTarget(job, config);
            if (!target) {
                return {
                    status: 'error',
                    error: `任务 ${job.id} 未配置发送目标；请设置 cron_job_add.target 或 config.ios.cron.defaultTarget`,
                };
            }

            await conversationRuntime.reloadIfNeeded();
            currentAgent = conversationRuntime.getAgent();

            const threadId = `cron-ios-${job.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const cronMessages = await conversationRuntime.buildBootstrapMessages({
                threadId,
                workspacePath: memoryWorkspacePath,
                scopeKey: 'main',
            });
            cronMessages.push({
                role: 'user',
                content: `[定时任务 ${job.name}] ${job.payload.message}`,
            });
            const invokeResult = await currentAgent.invoke(
                {
                    messages: cronMessages,
                },
                {
                    configurable: { thread_id: threadId },
                    recursionLimit: config.agent.recursion_limit,
                }
            );

            const text = extractAgentResponseText(invokeResult) || '任务已执行，但未返回文本结果。';
            const useMarkdown = job.delivery.useMarkdown ?? iosConfig.cron?.useMarkdown ?? false;
            const title = job.delivery.title || iosConfig.cron?.title || `定时任务: ${job.name}`;
            const outboundText = useMarkdown
                ? `## ${job.name}\n\n${text}`
                : `【${job.name}】\n${text}`;

            await gateway.sendProactive({
                channel: 'ios',
                target,
                message: {
                    text: outboundText,
                    title,
                    useMarkdown,
                },
            });

            return {
                status: 'ok',
                summary: text.slice(0, 300),
            };
        },
    });

    await cronService.start();
    setCronService('ios', cronService);
    if (!getCronService()) {
        setCronService(cronService);
    }

    log.info('[iOS] Service started and ready for websocket clients.');
    console.log();
    console.log(`${colors.gray}Press Ctrl+C to stop iOS service.${colors.reset}`);
    console.log();

    let isShuttingDown = false;
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        log.info('[iOS] Shutting down...');

        if (gateway) {
            try {
                await gateway.stop();
            } catch (error) {
                log.warn('[iOS] gateway stop failed:', error instanceof Error ? error.message : String(error));
            }
        }

        if (cronService) {
            try {
                await cronService.stop();
            } catch (error) {
                log.warn('[iOS] cron service stop failed:', error instanceof Error ? error.message : String(error));
            }
            setCronService('ios', null);
        }

        skillMonitor.close();

        try {
            await conversationRuntime.close();
        } catch (error) {
            log.warn('[iOS] MCP cleanup failed:', error instanceof Error ? error.message : String(error));
        }

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
    startIOSService({
        registerSignalHandlers: true,
        exitOnShutdown: true,
    }).catch((error) => {
        console.error(`${colors.red}Fatal error:${colors.reset}`, error);
        process.exit(1);
    });
}
