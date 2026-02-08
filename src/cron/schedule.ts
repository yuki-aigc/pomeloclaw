import { Cron } from 'croner';
import type { CronJob, CronSchedule, CronScheduleInput } from './types.js';

const EVERY_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;
const UNIT_TO_MS: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
};

function parseAtMs(raw: string): number {
    const trimmed = raw.trim();
    const atMs = Date.parse(trimmed);
    if (!Number.isFinite(atMs)) {
        throw new Error(`无效的 at 时间: ${raw}`);
    }
    return atMs;
}

export function normalizeTimezone(raw: string | undefined, fallback?: string): string | undefined {
    const candidate = raw?.trim() || fallback?.trim();
    if (!candidate) {
        return undefined;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
        return candidate;
    } catch {
        if (!fallback) {
            throw new Error(`无效的时区: ${candidate}`);
        }
        return fallback;
    }
}

export function parseEveryMs(raw: string | number): number {
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || raw <= 0) {
            throw new Error('every 必须是大于 0 的数字');
        }
        return Math.floor(raw);
    }

    const trimmed = raw.trim();
    const match = trimmed.match(EVERY_PATTERN);
    if (!match) {
        throw new Error('every 格式无效，示例: 30s / 5m / 1h');
    }
    const value = Number(match[1]);
    const unit = (match[2] || 'ms').toLowerCase();
    const base = UNIT_TO_MS[unit];
    if (!Number.isFinite(value) || value <= 0 || !base) {
        throw new Error('every 格式无效，示例: 30s / 5m / 1h');
    }
    const ms = value * base;
    if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error('every 解析失败');
    }
    return Math.floor(ms);
}

export function normalizeSchedule(
    input: CronScheduleInput,
    nowMs: number,
    defaultTimezone?: string
): CronSchedule {
    if (input.kind === 'at') {
        const atMs = parseAtMs(input.at);
        return {
            kind: 'at',
            at: new Date(atMs).toISOString(),
        };
    }

    if (input.kind === 'every') {
        const everyMs = parseEveryMs(input.every);
        const anchorMs =
            typeof input.anchorMs === 'number' && Number.isFinite(input.anchorMs)
                ? Math.max(0, Math.floor(input.anchorMs))
                : nowMs;
        return {
            kind: 'every',
            everyMs,
            anchorMs,
        };
    }

    const expr = input.expr.trim();
    if (!expr) {
        throw new Error('cron 表达式不能为空');
    }
    const timezone = normalizeTimezone(input.timezone, defaultTimezone);
    try {
        const instance = new Cron(expr, {
            timezone,
            maxRuns: 1,
        });
        instance.nextRun(new Date(nowMs));
    } catch (error) {
        throw new Error(`cron 表达式无效: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
        kind: 'cron',
        expr,
        timezone,
    };
}

export function computeNextRunAtMs(
    job: Pick<CronJob, 'enabled' | 'schedule'>,
    nowMs: number,
    defaultTimezone?: string
): number | undefined {
    if (!job.enabled) {
        return undefined;
    }
    if (job.schedule.kind === 'at') {
        return parseAtMs(job.schedule.at);
    }
    if (job.schedule.kind === 'every') {
        const everyMs = Math.max(1, Math.floor(job.schedule.everyMs));
        const anchorMs = Math.max(0, Math.floor(job.schedule.anchorMs));
        if (nowMs <= anchorMs) {
            return anchorMs + everyMs;
        }
        const elapsed = nowMs - anchorMs;
        const periods = Math.floor(elapsed / everyMs) + 1;
        return anchorMs + periods * everyMs;
    }

    const timezone = normalizeTimezone(job.schedule.timezone, defaultTimezone);
    const instance = new Cron(job.schedule.expr, {
        timezone,
        maxRuns: 1,
    });
    const next = instance.nextRun(new Date(nowMs));
    return next ? next.getTime() : undefined;
}

export function formatScheduleSummary(schedule: CronSchedule): string {
    if (schedule.kind === 'at') {
        return `at ${schedule.at}`;
    }
    if (schedule.kind === 'every') {
        const ms = schedule.everyMs;
        if (ms % (24 * 60 * 60 * 1000) === 0) return `every ${ms / (24 * 60 * 60 * 1000)}d`;
        if (ms % (60 * 60 * 1000) === 0) return `every ${ms / (60 * 60 * 1000)}h`;
        if (ms % (60 * 1000) === 0) return `every ${ms / (60 * 1000)}m`;
        if (ms % 1000 === 0) return `every ${ms / 1000}s`;
        return `every ${ms}ms`;
    }
    return schedule.timezone
        ? `cron "${schedule.expr}" (${schedule.timezone})`
        : `cron "${schedule.expr}"`;
}
