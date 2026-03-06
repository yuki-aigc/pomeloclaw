/**
 * DingTalk Entry Point
 * 
 * Runs the SRE Bot as a DingTalk robot using Stream mode.
 * All CLI mechanisms (memory, compaction, skills, exec) are preserved.
 * 
 * Usage: pnpm dingtalk
 */

import { DWClient } from 'dingtalk-stream';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client as PgClient, type ClientConfig as PgClientConfig } from 'pg';
import type { ExecApprovalRequest } from './agent.js';
import { WORKING_SUMMARY_REQUIREMENTS, WORKING_SUMMARY_SCHEMA } from './compaction/summary-schema.js';
import { loadConfig, type AgentMemoryConfig } from './config.js';
import { ConversationRuntime } from './conversation/runtime.js';
import {
    handleMessage,
    flushSessionsOnShutdown,
    closeSessionResources,
    type Logger,
    type DingTalkInboundMessage,
} from './channels/dingtalk/index.js';
import { sendProactiveMessage } from './channels/dingtalk/client.js';
import { createDingTalkChannelAdapter } from './channels/dingtalk/adapter.js';
import { requestDingTalkExecApproval, withApprovalContext } from './channels/dingtalk/approvals.js';
import { GatewayService } from './channels/gateway/index.js';
import { CronService } from './cron/service.js';
import { setCronService } from './cron/runtime.js';
import { resolveCronStorePath } from './cron/store.js';
import type { CronJob } from './cron/types.js';
import type { RuntimeLogWriter } from './log/runtime.js';
import {
    createRuntimeConsoleLogger,
    extractAgentResponseText,
    printChannelHeader,
    terminalColors as colors,
    toGatewayLogger,
} from './channels/runtime-entry.js';
import { createSkillDirectoryMonitor } from './skills/index.js';

const AUTO_MEMORY_SAVE_JOB_NAME = '系统任务：每日记忆归档(04:00)';
const AUTO_MEMORY_SAVE_JOB_MARKER = '[system:auto-memory-save-4am:v1]';
const AUTO_MEMORY_SAVE_JOB_CRON_EXPR = '0 4 * * *';
const DEFAULT_STREAM_LOCK_WAIT_MS = 120_000;
const STREAM_LOCK_RETRY_MS = 1_000;

function buildAutoMemorySaveJobDescription(): string {
    return `自动创建，请勿删除。${AUTO_MEMORY_SAVE_JOB_MARKER}`;
}

export function buildAutoMemorySaveJobPrompt(): string {
    return [
        '请执行每日记忆归档任务。',
        '要求：',
        '1. 回顾最近24小时对话中的关键事实、告警分析、定位结论、处置动作、遗留风险与待办。',
        '2. 输出内容必须使用以下固定结构；没有信息时写“无”：',
        WORKING_SUMMARY_SCHEMA,
        '3. 输出内容必须满足以下要求：',
        ...WORKING_SUMMARY_REQUIREMENTS.map((item, index) => `   ${index + 1}) ${item}`),
        '4. 调用 memory_save，target 必须是 daily；content 直接填写上面的结构化摘要正文，不要包“对话摘要:”前缀。',
        '5. 完成后在回复末尾明确输出: memory_saved。',
        '注意：若你没有调用 memory_save 就结束任务，视为失败。',
    ].join('\n');
}

function buildPgClientConfig(memoryConfig: AgentMemoryConfig): PgClientConfig | null {
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

type StreamLockHandle = {
    release: () => Promise<void>;
};

type AdvisoryLockHolder = {
    pid: number;
    applicationName?: string;
    state?: string;
    clientAddr?: string;
    backendStart?: string;
    xactStart?: string;
    queryStart?: string;
    query?: string;
};

async function getCurrentPgBackendPid(client: PgClient): Promise<number | null> {
    try {
        const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return result.rows[0]?.pid ?? null;
    } catch {
        return null;
    }
}

async function listAdvisoryLockHolders(params: {
    client: PgClient;
    lockKey1: number;
    lockKey2: number;
}): Promise<AdvisoryLockHolder[]> {
    const result = await params.client.query<{
        pid: number;
        application_name: string | null;
        state: string | null;
        client_addr: string | null;
        backend_start: string | null;
        xact_start: string | null;
        query_start: string | null;
        query: string | null;
    }>(
        `SELECT
            l.pid,
            a.application_name,
            a.state,
            a.client_addr::text AS client_addr,
            a.backend_start::text AS backend_start,
            a.xact_start::text AS xact_start,
            a.query_start::text AS query_start,
            a.query
         FROM pg_locks l
         LEFT JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory'
           AND l.classid = $1
           AND l.objid = $2
           AND l.objsubid = 2
           AND l.granted = true
         ORDER BY a.backend_start NULLS LAST, l.pid`,
        [params.lockKey1, params.lockKey2],
    );

    return result.rows.map((row) => ({
        pid: row.pid,
        applicationName: row.application_name || undefined,
        state: row.state || undefined,
        clientAddr: row.client_addr || undefined,
        backendStart: row.backend_start || undefined,
        xactStart: row.xact_start || undefined,
        queryStart: row.query_start || undefined,
        query: row.query || undefined,
    }));
}

async function terminateAdvisoryLockHolders(params: {
    client: PgClient;
    holders: AdvisoryLockHolder[];
    selfPid: number | null;
    log: Logger;
    instanceId: string;
}): Promise<number> {
    let terminatedCount = 0;
    for (const holder of params.holders) {
        if (!holder.pid || holder.pid === params.selfPid) {
            continue;
        }
        try {
            const result = await params.client.query<{ terminated: boolean }>(
                'SELECT pg_terminate_backend($1) AS terminated',
                [holder.pid],
            );
            const terminated = Boolean(result.rows[0]?.terminated);
            params.log.warn(
                `[DingTalk] advisory lock holder terminate ${terminated ? 'succeeded' : 'skipped'}: ` +
                `instance=${params.instanceId} pid=${holder.pid} app=${holder.applicationName || ''} state=${holder.state || ''} client=${holder.clientAddr || ''}`,
            );
            if (terminated) {
                terminatedCount += 1;
            }
        } catch (error) {
            params.log.warn(
                `[DingTalk] advisory lock holder terminate failed: instance=${params.instanceId} pid=${holder.pid} ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    return terminatedCount;
}

async function acquireDingTalkStreamLock(params: {
    config: ReturnType<typeof loadConfig>;
    clientId: string;
    log: Logger;
    instanceId: string;
}): Promise<StreamLockHandle | null> {
    const { config, clientId, log, instanceId } = params;
    const memoryConfig = config.agent.memory;
    if (memoryConfig.backend !== 'pgsql' && !memoryConfig.pgsql.enabled) {
        return null;
    }

    const streamLockWaitMs = Math.max(5_000, Math.floor(config.dingtalk?.streamLockWaitMs ?? DEFAULT_STREAM_LOCK_WAIT_MS));
    const forceTerminateOnTimeout = Boolean(config.dingtalk?.streamLockForceTerminateOnTimeout);
    const forceTerminateWaitMs = Math.max(1_000, Math.floor(config.dingtalk?.streamLockForceTerminateWaitMs ?? 15_000));
    const clientConfig = buildPgClientConfig(memoryConfig);
    if (!clientConfig) {
        return null;
    }

    const lockDigest = createHash('sha256').update(`dingtalk-stream:${clientId}`).digest();
    const lockKey1 = lockDigest.readInt32BE(0);
    const lockKey2 = lockDigest.readInt32BE(4);
    const client = new PgClient({
        ...clientConfig,
        application_name: `pomelobot-dingtalk-lock:${instanceId}`,
    });

    try {
        await client.connect();
    } catch (error) {
        log.warn(
            `[DingTalk] advisory lock skipped: PG connect failed for instance=${instanceId}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
        await client.end().catch(() => undefined);
        return null;
    }

    const selfPid = await getCurrentPgBackendPid(client);
    const deadline = Date.now() + streamLockWaitMs;
    let attempt = 0;
    while (Date.now() < deadline) {
        attempt += 1;
        try {
            const result = await client.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock($1, $2) AS locked',
                [lockKey1, lockKey2]
            );
            if (result.rows[0]?.locked) {
                return {
                    release: async () => {
                        try {
                            await client.query('SELECT pg_advisory_unlock($1, $2)', [lockKey1, lockKey2]);
                        } catch (error) {
                            log.warn(
                                `[DingTalk] advisory lock release failed: instance=${instanceId} ` +
                                `${error instanceof Error ? error.message : String(error)}`
                            );
                        } finally {
                            await client.end().catch(() => undefined);
                        }
                    },
                };
            }
        } catch (error) {
            log.warn(
                `[DingTalk] advisory lock query failed: instance=${instanceId} attempt=${attempt} ` +
                `${error instanceof Error ? error.message : String(error)}`
            );
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, STREAM_LOCK_RETRY_MS));
    }

    if (forceTerminateOnTimeout) {
        try {
            const holders = await listAdvisoryLockHolders({
                client,
                lockKey1,
                lockKey2,
            });
            if (holders.length > 0) {
                for (const holder of holders) {
                    log.warn(
                        `[DingTalk] advisory lock holder detected: instance=${instanceId} pid=${holder.pid} ` +
                        `app=${holder.applicationName || ''} state=${holder.state || ''} client=${holder.clientAddr || ''} ` +
                        `backend_start=${holder.backendStart || ''}`,
                    );
                }
                const terminatedCount = await terminateAdvisoryLockHolders({
                    client,
                    holders,
                    selfPid,
                    log,
                    instanceId,
                });
                if (terminatedCount > 0) {
                    const forceDeadline = Date.now() + forceTerminateWaitMs;
                    while (Date.now() < forceDeadline) {
                        try {
                            const result = await client.query<{ locked: boolean }>(
                                'SELECT pg_try_advisory_lock($1, $2) AS locked',
                                [lockKey1, lockKey2],
                            );
                            if (result.rows[0]?.locked) {
                                log.warn(
                                    `[DingTalk] advisory lock takeover succeeded after terminating stale holder(s): instance=${instanceId} count=${terminatedCount}`,
                                );
                                return {
                                    release: async () => {
                                        try {
                                            await client.query('SELECT pg_advisory_unlock($1, $2)', [lockKey1, lockKey2]);
                                        } catch (error) {
                                            log.warn(
                                                `[DingTalk] advisory lock release failed: instance=${instanceId} ` +
                                                `${error instanceof Error ? error.message : String(error)}`,
                                            );
                                        } finally {
                                            await client.end().catch(() => undefined);
                                        }
                                    },
                                };
                            }
                        } catch (error) {
                            log.warn(
                                `[DingTalk] advisory lock retry after terminate failed: instance=${instanceId} ` +
                                `${error instanceof Error ? error.message : String(error)}`,
                            );
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, STREAM_LOCK_RETRY_MS));
                    }
                }
            }
        } catch (error) {
            log.warn(
                `[DingTalk] advisory lock holder inspection failed: instance=${instanceId} ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    await client.end().catch(() => undefined);
    throw new Error(
        `DingTalk stream lock held by another instance for more than ${streamLockWaitMs}ms`
        + (forceTerminateOnTimeout ? ` (force terminate attempted for ${forceTerminateWaitMs}ms)` : ''),
    );
}

function instrumentDingTalkClient(client: DWClient, log: Logger, instanceId: string): void {
    const rawClient = client as any;
    let connectInFlight: Promise<void> | null = null;
    let connectAttempt = 0;

    const attachSocketInstrumentation = (socket: any): void => {
        if (!socket || socket.__pomelobotInstrumented) {
            return;
        }
        socket.__pomelobotInstrumented = true;

        socket.on('open', () => {
            client.emit('pomelobot:stream:socket_open');
        });
    };

    const waitForReady = (): Promise<void> =>
        new Promise((resolve) => {
            if (client.connected && client.registered) {
                resolve();
                return;
            }

            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, 5000);

            const onRegistered = () => {
                cleanup();
                resolve();
            };
            const onOpen = () => {
                setTimeout(() => {
                    cleanup();
                    resolve();
                }, 300);
            };

            const cleanup = () => {
                clearTimeout(timer);
                client.off('pomelobot:stream:registered', onRegistered);
                client.off('pomelobot:stream:open', onOpen);
                client.off('pomelobot:stream:socket_open', onOpen);
            };

            client.on('pomelobot:stream:registered', onRegistered);
            client.on('pomelobot:stream:open', onOpen);
            client.on('pomelobot:stream:socket_open', onOpen);
        });

    const originalConnect = client.connect.bind(client);
    client.connect = async () => {
        if (connectInFlight) {
            return connectInFlight;
        }

        if (client.connected && client.registered) {
            return;
        }

        connectAttempt += 1;
        const attempt = connectAttempt;

        connectInFlight = originalConnect()
            .then(() => {
                attachSocketInstrumentation(rawClient.socket);
                return waitForReady();
            })
            .catch((error) => {
                log.warn(
                    `[DingTalk] stream connect failed: instance=${instanceId} attempt=${attempt} ` +
                    `${error instanceof Error ? error.message : String(error)}`
                );
                throw error;
            })
            .finally(() => {
                connectInFlight = null;
            });

        return connectInFlight;
    };

    const originalDisconnect = client.disconnect.bind(client);
    client.disconnect = () => {
        originalDisconnect();
    };

    if (typeof rawClient.onSystem === 'function') {
        const originalOnSystem = rawClient.onSystem.bind(client);
        rawClient.onSystem = (downstream: { headers?: { topic?: string }; data?: string }) => {
            const topic = downstream?.headers?.topic || 'unknown';
            if (topic === 'CONNECTED') {
                client.emit('pomelobot:stream:open');
            } else if (topic === 'REGISTERED') {
                client.emit('pomelobot:stream:registered');
            }
            const result = originalOnSystem(downstream);
            if (topic === 'disconnect') {
                setTimeout(() => {
                    try {
                        rawClient.socket?.terminate?.();
                    } catch (error) {
                        log.warn(
                            `[DingTalk] stream terminate on disconnect failed: instance=${instanceId} ` +
                            `${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }, 0);
            }
            return result;
        };
    }
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
                channel: 'dingtalk',
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
        delivery?: { channel?: string; target?: string; title?: string; useMarkdown?: boolean };
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
        (primary.delivery.channel || 'dingtalk') !== 'dingtalk'
        || (primary.delivery.target || '').trim() !== defaultTarget
        || (primary.delivery.title || '') !== desiredTitle
        || (primary.delivery.useMarkdown ?? true) !== desiredUseMarkdown;
    if (shouldPatchDelivery) {
        patch.delivery = {
            channel: 'dingtalk',
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

function buildCronDeliveryChannel(job: CronJob): string {
    return job.delivery.channel?.trim().toLowerCase() || 'dingtalk';
}

function buildCronDeliveryTarget(job: CronJob, config: ReturnType<typeof loadConfig>): string | undefined {
    const fromJob = job.delivery.target?.trim();
    if (fromJob) return fromJob;
    const fromConfig = config.dingtalk?.cron?.defaultTarget?.trim();
    if (fromConfig) return fromConfig;
    return undefined;
}

export async function startDingTalkService(options?: {
    registerSignalHandlers?: boolean;
    exitOnShutdown?: boolean;
    logWriter?: RuntimeLogWriter;
}): Promise<{ shutdown: () => Promise<void> }> {
    const registerSignalHandlers = options?.registerSignalHandlers ?? false;
    const exitOnShutdown = options?.exitOnShutdown ?? false;
    const config = loadConfig();
    let cronService: CronService | null = null;
    let gateway: GatewayService | null = null;

    // Validate DingTalk configuration
    if (!config.dingtalk) {
        throw new Error('DingTalk configuration not found in config.json');
    }

    const dingtalkConfig = config.dingtalk;
    const memoryWorkspacePath = resolve(process.cwd(), config.agent.workspace);
    const skillsPath = resolve(process.cwd(), config.agent.skills_dir);

    if (!dingtalkConfig.clientId || !dingtalkConfig.clientSecret) {
        throw new Error('DingTalk clientId and clientSecret are required');
    }

    if (dingtalkConfig.clientId === 'YOUR_DINGTALK_APP_KEY') {
        throw new Error('Please replace placeholder DingTalk credentials in config.json');
    }

    printChannelHeader({
        config,
        modeLabel: 'DingTalk Mode',
        statusLines: [
            'Memory & Skills Enabled',
            'Stream Mode (No Public IP Required)',
        ],
    });

    // Create logger
    const log: Logger = createRuntimeConsoleLogger({
        debug: dingtalkConfig.debug,
        logWriter: options?.logWriter,
    });

    // Create agent
    log.info('[DingTalk] Initializing agent...');
    const execApprovalPrompt = async (request: ExecApprovalRequest) =>
        requestDingTalkExecApproval(request);
    const conversationRuntime = new ConversationRuntime({
        config,
        runtimeChannel: 'dingtalk',
        execApprovalPrompt,
    });
    await conversationRuntime.initialize();
    let currentAgent = conversationRuntime.getAgent();
    log.info('[DingTalk] Agent initialized successfully');
    const skillMonitor = createSkillDirectoryMonitor({
        skillsDir: skillsPath,
        logger: log,
        onChange: () => {
            conversationRuntime.requestReload();
            log.info('[DingTalk] Skills changed on disk, reload scheduled for next request.');
        },
    });

    // Create DingTalk Stream client
    log.info('[DingTalk] Connecting to DingTalk Stream...');
    const streamInstanceId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const streamUA = `pomelobot/${streamInstanceId}`;
    let streamLock: StreamLockHandle | null = await acquireDingTalkStreamLock({
        config,
        clientId: dingtalkConfig.clientId,
        log,
        instanceId: streamInstanceId,
    });
    let client: DWClient | null = null;

    // Message handler context
    const ctx = {
        agent: currentAgent,
        config,
        dingtalkConfig,
        log,
        switchModel: async (alias: string) => {
            const result = await conversationRuntime.switchModel(alias);
            currentAgent = conversationRuntime.getAgent();
            ctx.agent = currentAgent;
            return result;
        },
        reloadAgent: async () => {
            await conversationRuntime.reloadAgent();
            currentAgent = conversationRuntime.getAgent();
            ctx.agent = currentAgent;
        },
        reloadIfNeeded: async () => {
            const reloaded = await conversationRuntime.reloadIfNeeded();
            if (reloaded) {
                currentAgent = conversationRuntime.getAgent();
                ctx.agent = currentAgent;
            }
        },
        skillsDir: skillsPath,
    };

    cronService = new CronService({
        enabled: config.cron.enabled,
        timezone: config.cron.timezone,
        storePath: resolveCronStorePath(config.cron.store),
        runLogPath: config.cron.runLog,
        defaultDelivery: {
            channel: 'dingtalk',
            target: dingtalkConfig.cron?.defaultTarget,
            useMarkdown: dingtalkConfig.cron?.useMarkdown,
            title: dingtalkConfig.cron?.title,
        },
        logger: toGatewayLogger(log),
        runJob: async (job) => {
            const deliveryChannel = buildCronDeliveryChannel(job);
            if (deliveryChannel !== 'dingtalk') {
                return {
                    status: 'skipped',
                    error: `任务 ${job.id} 配置 channel=${deliveryChannel}，当前实例仅处理 dingtalk`,
                };
            }

            const target = buildCronDeliveryTarget(job, config);
            if (!target) {
                return {
                    status: 'error',
                    error: `任务 ${job.id} 未配置发送目标；请设置 cron_job_add.target 或 config.dingtalk.cron.defaultTarget`,
                };
            }

            await conversationRuntime.reloadIfNeeded();
            currentAgent = conversationRuntime.getAgent();
            ctx.agent = currentAgent;

            const threadId = `cron-${job.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
    setCronService('dingtalk', cronService);
    setCronService(cronService);

    let isShuttingDown = false;
    try {
        client = new DWClient({
            clientId: dingtalkConfig.clientId,
            clientSecret: dingtalkConfig.clientSecret,
            debug: dingtalkConfig.debug || false,
            // Rely on Stream protocol ping/disconnect + SDK autoReconnect.
            // The SDK's ws keepAlive timer is not cleared on socket close, only on disconnect().
            keepAlive: false,
            ua: streamUA,
        });
        instrumentDingTalkClient(client, log, streamInstanceId);

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
            logger: toGatewayLogger(log),
        });
        const dingtalkAdapter = createDingTalkChannelAdapter({
            config: dingtalkConfig,
            log,
            client,
            isShuttingDown: () => isShuttingDown,
        });
        gateway.registerAdapter(dingtalkAdapter);
        await gateway.start();

        // Connect to DingTalk
        await client.connect();
    } catch (error) {
        if (gateway) {
            try {
                await gateway.stop();
            } catch (stopError) {
                log.warn('[DingTalk] gateway stop failed during startup rollback:', stopError instanceof Error ? stopError.message : String(stopError));
            }
            gateway = null;
        }
        if (client) {
            try {
                client.disconnect();
            } catch (disconnectError) {
                log.warn('[DingTalk] stream disconnect failed during startup rollback:', disconnectError instanceof Error ? disconnectError.message : String(disconnectError));
            }
        }
        if (streamLock) {
            try {
                await streamLock.release();
            } catch (releaseError) {
                log.warn('[DingTalk] stream lock release failed during startup rollback:', releaseError instanceof Error ? releaseError.message : String(releaseError));
            }
            streamLock = null;
        }
        throw error;
    }
    log.info('[DingTalk] Connected! Bot is now online and listening for messages.');
    console.log();
    console.log(`${colors.gray}Press Ctrl+C to stop the bot.${colors.reset}`);
    console.log();

    // Handle graceful shutdown
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        console.log();
        log.info('[DingTalk] Shutting down...');

        try {
            log.info('[DingTalk] Disconnecting DingTalk Stream before draining...');
            client?.disconnect();
        } catch (error) {
            log.warn('[DingTalk] stream disconnect failed:', error instanceof Error ? error.message : String(error));
        }

        if (gateway) {
            try {
                await gateway.stop();
            } catch (error) {
                log.warn('[DingTalk] gateway stop failed:', error instanceof Error ? error.message : String(error));
            }
        }

        if (streamLock) {
            try {
                await streamLock.release();
            } catch (error) {
                log.warn('[DingTalk] stream lock release failed:', error instanceof Error ? error.message : String(error));
            }
        }

        if (cronService) {
            try {
                await cronService.stop();
            } catch (error) {
                log.warn('[DingTalk] cron service stop failed:', error instanceof Error ? error.message : String(error));
            }
            setCronService('dingtalk', null);
        }
        skillMonitor.close();

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

        try {
            await closeSessionResources(log);
        } catch (error) {
            log.warn('[DingTalk] session resource cleanup failed:', error instanceof Error ? error.message : String(error));
        }

        try {
            await conversationRuntime.close();
        } catch (error) {
            log.warn('[DingTalk] MCP cleanup failed:', error instanceof Error ? error.message : String(error));
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
