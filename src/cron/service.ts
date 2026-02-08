import { randomUUID } from 'node:crypto';
import type {
    CronDeliveryConfig,
    CronJob,
    CronJobCreateInput,
    CronJobPatchInput,
    CronLogger,
    CronRunResult,
    CronStoreFile,
} from './types.js';
import {
    computeNextRunAtMs,
    formatScheduleSummary,
    normalizeSchedule,
} from './schedule.js';
import {
    appendCronRunLog,
    loadCronStore,
    resolveCronRunLogPath,
    saveCronStore,
} from './store.js';

type CronServiceOptions = {
    enabled: boolean;
    timezone?: string;
    storePath: string;
    runLogPath?: string;
    defaultDelivery?: CronDeliveryConfig;
    logger?: CronLogger;
    runJob: (job: CronJob) => Promise<CronRunResult>;
};

export class CronService {
    private readonly enabled: boolean;
    private readonly timezone?: string;
    private readonly storePath: string;
    private readonly runLogPath: string;
    private readonly logger: Required<CronLogger>;
    private readonly runJobImpl: (job: CronJob) => Promise<CronRunResult>;
    private readonly defaultDelivery: CronDeliveryConfig;

    private store: CronStoreFile = { version: 1, jobs: [] };
    private started = false;
    private timer: NodeJS.Timeout | null = null;
    private lockChain: Promise<void> = Promise.resolve();
    private ticking = false;

    constructor(options: CronServiceOptions) {
        this.enabled = options.enabled;
        this.timezone = options.timezone;
        this.storePath = options.storePath;
        this.runLogPath = resolveCronRunLogPath(this.storePath, options.runLogPath);
        this.runJobImpl = options.runJob;
        this.defaultDelivery = options.defaultDelivery || {};
        this.logger = {
            debug: options.logger?.debug ?? (() => undefined),
            info: options.logger?.info ?? (() => undefined),
            warn: options.logger?.warn ?? (() => undefined),
            error: options.logger?.error ?? (() => undefined),
        };
    }

    getStatus() {
        return {
            enabled: this.enabled,
            started: this.started,
            timezone: this.timezone,
            storePath: this.storePath,
            runLogPath: this.runLogPath,
            jobCount: this.store.jobs.length,
        };
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.store = await loadCronStore(this.storePath);
        await this.withLock(async () => {
            this.recomputeAllNextRuns(Date.now());
            await saveCronStore(this.storePath, this.store);
        });
        this.started = true;
        if (this.enabled) {
            this.armTimer();
            this.logger.info('[Cron] service started');
        } else {
            this.logger.info('[Cron] service loaded in disabled mode');
        }
    }

    async stop(): Promise<void> {
        this.started = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        await this.withLock(async () => {
            await saveCronStore(this.storePath, this.store);
        });
    }

    async listJobs(): Promise<CronJob[]> {
        return this.withLock(async () =>
            [...this.store.jobs]
                .sort((a, b) => {
                    const aNext = a.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
                    const bNext = b.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
                    return aNext - bNext;
                })
                .map((job) => structuredClone(job))
        );
    }

    async getJob(id: string): Promise<CronJob | null> {
        const trimmed = id.trim();
        if (!trimmed) return null;
        return this.withLock(async () => {
            const found = this.store.jobs.find((job) => job.id === trimmed);
            return found ? structuredClone(found) : null;
        });
    }

    async addJob(input: CronJobCreateInput): Promise<CronJob> {
        const now = Date.now();
        const name = input.name.trim();
        if (!name) {
            throw new Error('任务名称不能为空');
        }
        const message = input.payload.message.trim();
        if (!message) {
            throw new Error('任务内容不能为空');
        }
        const schedule = normalizeSchedule(input.schedule, now, this.timezone);
        const job: CronJob = {
            id: randomUUID(),
            name,
            description: input.description?.trim() || undefined,
            enabled: input.enabled ?? true,
            createdAtMs: now,
            updatedAtMs: now,
            schedule,
            payload: {
                kind: 'agentTurn',
                message,
            },
            delivery: this.resolveDelivery(input.delivery),
            state: {},
        };
        job.state.nextRunAtMs = computeNextRunAtMs(job, now, this.timezone);

        await this.withLock(async () => {
            this.store.jobs.push(job);
            await saveCronStore(this.storePath, this.store);
        });
        this.armTimer();
        this.logger.info(`[Cron] added job ${job.id} (${job.name}) -> ${formatScheduleSummary(job.schedule)}`);
        return structuredClone(job);
    }

    async updateJob(id: string, patch: CronJobPatchInput): Promise<CronJob> {
        const trimmedId = id.trim();
        if (!trimmedId) throw new Error('任务 ID 不能为空');

        const updated = await this.withLock(async () => {
            const job = this.store.jobs.find((item) => item.id === trimmedId);
            if (!job) throw new Error(`未找到任务: ${trimmedId}`);

            if (patch.name !== undefined) {
                const name = patch.name.trim();
                if (!name) throw new Error('任务名称不能为空');
                job.name = name;
            }
            if (patch.description !== undefined) {
                job.description = patch.description.trim() || undefined;
            }
            if (patch.enabled !== undefined) {
                job.enabled = patch.enabled;
                if (!patch.enabled) {
                    job.state.runningAtMs = undefined;
                }
            }
            if (patch.payload?.message !== undefined) {
                const message = patch.payload.message.trim();
                if (!message) throw new Error('任务内容不能为空');
                job.payload.message = message;
            }
            if (patch.schedule) {
                job.schedule = normalizeSchedule(patch.schedule, Date.now(), this.timezone);
            }
            if (patch.delivery) {
                job.delivery = this.resolveDelivery({
                    ...job.delivery,
                    ...patch.delivery,
                });
            }

            job.updatedAtMs = Date.now();
            const now = Date.now();
            if (job.enabled && job.state.runningAtMs === undefined) {
                job.state.nextRunAtMs = computeNextRunAtMs(job, now, this.timezone);
            } else if (!job.enabled) {
                job.state.nextRunAtMs = undefined;
            }

            await saveCronStore(this.storePath, this.store);
            return structuredClone(job);
        });

        this.armTimer();
        this.logger.info(`[Cron] updated job ${updated.id}`);
        return updated;
    }

    async deleteJob(id: string): Promise<boolean> {
        const trimmedId = id.trim();
        if (!trimmedId) return false;
        const removed = await this.withLock(async () => {
            const before = this.store.jobs.length;
            this.store.jobs = this.store.jobs.filter((job) => job.id !== trimmedId);
            const changed = this.store.jobs.length !== before;
            if (changed) {
                await saveCronStore(this.storePath, this.store);
            }
            return changed;
        });
        if (removed) {
            this.armTimer();
        }
        return removed;
    }

    async runJobNow(id: string): Promise<CronRunResult> {
        const trimmedId = id.trim();
        if (!trimmedId) {
            throw new Error('任务 ID 不能为空');
        }
        const started = Date.now();
        const job = await this.markJobRunning(trimmedId, started);
        if (!job) {
            throw new Error(`未找到任务: ${trimmedId}`);
        }
        const result = await this.executeJob(job, 'manual', started);
        this.armTimer();
        return result;
    }

    private resolveDelivery(input?: CronDeliveryConfig): CronDeliveryConfig {
        const merged: CronDeliveryConfig = {
            ...this.defaultDelivery,
            ...(input || {}),
        };
        if (merged.target) {
            merged.target = merged.target.trim() || undefined;
        }
        if (merged.title) {
            merged.title = merged.title.trim() || undefined;
        }
        if (!merged.target) {
            delete merged.target;
        }
        if (!merged.title) {
            delete merged.title;
        }
        return merged;
    }

    private async tick(): Promise<void> {
        if (!this.enabled || !this.started || this.ticking) {
            return;
        }
        this.ticking = true;
        try {
            const now = Date.now();
            const due = await this.withLock(async () => {
                const jobs = this.store.jobs.filter((job) =>
                    job.enabled &&
                    typeof job.state.nextRunAtMs === 'number' &&
                    job.state.nextRunAtMs <= now &&
                    job.state.runningAtMs === undefined
                );

                if (jobs.length === 0) {
                    return [] as CronJob[];
                }

                for (const job of jobs) {
                    job.state.runningAtMs = now;
                }
                await saveCronStore(this.storePath, this.store);
                return jobs.map((job) => structuredClone(job));
            });

            for (const job of due) {
                await this.executeJob(job, 'scheduled', Date.now());
            }
        } finally {
            this.ticking = false;
            this.armTimer();
        }
    }

    private async executeJob(
        job: CronJob,
        trigger: 'scheduled' | 'manual',
        startedAtMs: number
    ): Promise<CronRunResult> {
        let result: CronRunResult;
        try {
            result = await this.runJobImpl(job);
        } catch (error) {
            result = {
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
            };
        }

        const endedAtMs = Date.now();
        await this.finishJobRun({
            jobId: job.id,
            trigger,
            startedAtMs,
            endedAtMs,
            result,
        });
        return result;
    }

    private async markJobRunning(id: string, runningAtMs: number): Promise<CronJob | null> {
        return this.withLock(async () => {
            const job = this.store.jobs.find((item) => item.id === id);
            if (!job) return null;
            if (job.state.runningAtMs !== undefined) {
                throw new Error(`任务正在执行中: ${job.id}`);
            }
            job.state.runningAtMs = runningAtMs;
            await saveCronStore(this.storePath, this.store);
            return structuredClone(job);
        });
    }

    private async finishJobRun(params: {
        jobId: string;
        trigger: 'scheduled' | 'manual';
        startedAtMs: number;
        endedAtMs: number;
        result: CronRunResult;
    }): Promise<void> {
        const { jobId, trigger, startedAtMs, endedAtMs, result } = params;
        let nextRunAtMs: number | undefined;
        let jobName = jobId;

        await this.withLock(async () => {
            const job = this.store.jobs.find((item) => item.id === jobId);
            if (!job) return;

            jobName = job.name;
            job.updatedAtMs = endedAtMs;
            job.state.runningAtMs = undefined;
            job.state.lastRunAtMs = endedAtMs;
            job.state.lastStatus = result.status;
            job.state.lastError = result.error;
            job.state.lastDurationMs = Math.max(0, endedAtMs - startedAtMs);

            if (job.schedule.kind === 'at') {
                job.enabled = false;
                job.state.nextRunAtMs = undefined;
            } else if (job.enabled) {
                job.state.nextRunAtMs = computeNextRunAtMs(job, endedAtMs, this.timezone);
            } else {
                job.state.nextRunAtMs = undefined;
            }

            nextRunAtMs = job.state.nextRunAtMs;
            await saveCronStore(this.storePath, this.store);
        });

        const durationMs = Math.max(0, endedAtMs - startedAtMs);
        await appendCronRunLog(this.runLogPath, {
            timestamp: new Date(endedAtMs).toISOString(),
            jobId,
            jobName,
            trigger,
            startedAtMs,
            endedAtMs,
            durationMs,
            status: result.status,
            summary: result.summary,
            error: result.error,
            nextRunAtMs,
        });

        if (result.status === 'error') {
            this.logger.warn(`[Cron] job ${jobId} failed: ${result.error || 'unknown error'}`);
        } else {
            this.logger.info(`[Cron] job ${jobId} finished (${result.status})`);
        }
    }

    private recomputeAllNextRuns(nowMs: number): void {
        for (const job of this.store.jobs) {
            if (job.state.runningAtMs !== undefined) {
                job.state.runningAtMs = undefined;
            }
            if (job.enabled) {
                job.state.nextRunAtMs = computeNextRunAtMs(job, nowMs, this.timezone);
            } else {
                job.state.nextRunAtMs = undefined;
            }
        }
    }

    private armTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.enabled || !this.started) {
            return;
        }

        const now = Date.now();
        let nextRunAt = Number.MAX_SAFE_INTEGER;
        for (const job of this.store.jobs) {
            if (!job.enabled || job.state.runningAtMs !== undefined) continue;
            if (typeof job.state.nextRunAtMs !== 'number') continue;
            if (job.state.nextRunAtMs < nextRunAt) {
                nextRunAt = job.state.nextRunAtMs;
            }
        }
        if (nextRunAt === Number.MAX_SAFE_INTEGER) {
            return;
        }
        const delayMs = Math.max(0, Math.min(nextRunAt - now, 60_000));
        this.timer = setTimeout(() => {
            void this.tick().catch((error) => {
                this.logger.error(`[Cron] timer tick failed: ${String(error)}`);
            });
        }, delayMs);
        this.timer.unref?.();
    }

    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.lockChain.then(fn, fn);
        this.lockChain = run.then(() => undefined, () => undefined);
        return run;
    }
}
