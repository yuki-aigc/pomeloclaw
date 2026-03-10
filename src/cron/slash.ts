import type { CronService } from './service.js';
import { getAllCronServices } from './runtime.js';
import type { CronJob } from './types.js';

export function parseCronSlashCommand(input: string): { type: 'list' } | null {
    const text = input.trim();
    if (text === '/cron') {
        return { type: 'list' };
    }
    return null;
}

function formatCronDateTime(ms?: number): string {
    if (typeof ms !== 'number') {
        return 'n/a';
    }
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function formatSlashSchedule(job: CronJob): string {
    if (job.schedule.kind === 'at') {
        return `一次性 ${job.schedule.at}`;
    }
    if (job.schedule.kind === 'every') {
        const everyMs = job.schedule.everyMs;
        if (everyMs % (24 * 60 * 60 * 1000) === 0) {
            return `每 ${everyMs / (24 * 60 * 60 * 1000)} 天一次`;
        }
        if (everyMs % (60 * 60 * 1000) === 0) {
            return `每 ${everyMs / (60 * 60 * 1000)} 小时一次`;
        }
        if (everyMs % (60 * 1000) === 0) {
            return `每 ${everyMs / (60 * 1000)} 分钟一次`;
        }
        return `每 ${Math.max(1, Math.floor(everyMs / 1000))} 秒一次`;
    }

    const cronMatch = job.schedule.expr.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/u);
    if (cronMatch) {
        const minute = cronMatch[1]?.padStart(2, '0') || '00';
        const hour = cronMatch[2]?.padStart(2, '0') || '00';
        const timezone = job.schedule.timezone || 'n/a';
        return `每天 ${hour}:${minute} (${timezone})`;
    }

    return job.schedule.timezone
        ? `cron ${job.schedule.expr} (${job.schedule.timezone})`
        : `cron ${job.schedule.expr}`;
}

function formatSlashStatus(job: CronJob): string {
    return job.enabled ? '已启用 ✅' : '已停用 ⏸️';
}

function formatSlashLastRun(job: CronJob): string {
    const lastRun = formatCronDateTime(job.state.lastRunAtMs);
    const status = job.state.lastStatus || 'n/a';
    return `${lastRun} (状态：${status})`;
}

function formatSlashChannel(job: CronJob): string {
    const channel = job.delivery.channel?.trim().toLowerCase();
    if (channel === 'dingtalk') return 'DingTalk';
    if (channel === 'ios') return 'iOS';
    if (channel === 'web') return 'Web';
    return channel || '未指定';
}

function summarizeJobPurpose(job: CronJob): string {
    if (job.name.includes('每日记忆归档')) {
        return '自动归档过去 24 小时的对话记忆，提取关键事实、告警分析、处置动作等，并识别可复用的团队知识';
    }

    const description = job.description?.trim();
    if (description && !description.includes('[system:auto-memory-save-4am')) {
        return description;
    }

    const payload = job.payload.message
        .replace(/\s+/g, ' ')
        .replace(/^请执行/u, '')
        .replace(/^要求：/u, '')
        .trim();
    if (!payload) {
        return '未提供功能说明';
    }
    return payload.length > 80 ? `${payload.slice(0, 79)}…` : payload;
}

function formatSlashJob(job: CronJob, index: number): string {
    return [
        `${index}. ${job.name}`,
        `ID: ${job.id}`,
        `调度: ${formatSlashSchedule(job)}`,
        `状态: ${formatSlashStatus(job)}`,
        `下次运行: ${formatCronDateTime(job.state.nextRunAtMs)}`,
        `上次运行: ${formatSlashLastRun(job)}`,
        `推送渠道: ${formatSlashChannel(job)}`,
        `功能: ${summarizeJobPurpose(job)}`,
    ].join('\n');
}

export async function executeCronSlashCommand(input: string): Promise<{ handled: boolean; response?: string }> {
    const command = parseCronSlashCommand(input);
    if (!command) {
        return { handled: false };
    }

    const services = getAllCronServices();
    if (services.length === 0) {
        return {
            handled: true,
            response: '📭 当前没有可用的 Cron 服务。',
        };
    }

    const allJobs: CronJob[] = [];
    for (const entry of services) {
        const jobs = await entry.service.listJobs();
        allJobs.push(...jobs);
    }

    if (allJobs.length === 0) {
        return {
            handled: true,
            response: '📭 当前没有定时任务。',
        };
    }

    allJobs.sort((a, b) => {
        const aNext = a.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        const bNext = b.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        if (aNext !== bNext) {
            return aNext - bNext;
        }
        return a.name.localeCompare(b.name, 'zh-CN');
    });

    const sections = allJobs.map((job, index) => formatSlashJob(job, index + 1));
    return {
        handled: true,
        response: `你当前有 ${allJobs.length} 个定时任务：\n\n${sections.join('\n\n')}`,
    };
}
