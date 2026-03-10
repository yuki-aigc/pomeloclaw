import type { CronJob } from './types.js';
import { formatScheduleSummary } from './schedule.js';

export function formatCronDateTime(ms?: number): string {
    if (typeof ms !== 'number') return 'n/a';
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function formatCronJob(job: CronJob): string {
    const lines = [
        `- id: ${job.id}`,
        `  name: ${job.name}`,
        `  enabled: ${job.enabled}`,
        `  schedule: ${formatCronSchedule(job)}`,
        `  nextRun: ${formatCronDateTime(job.state.nextRunAtMs)}`,
        `  lastRun: ${formatCronDateTime(job.state.lastRunAtMs)}`,
        `  lastStatus: ${job.state.lastStatus || 'n/a'}`,
        `  channel: ${job.delivery.channel || 'n/a'}`,
        `  target: ${job.delivery.target || 'n/a'}`,
        `  message: ${job.payload.message}`,
    ];
    if (job.state.lastError) {
        lines.push(`  lastError: ${job.state.lastError}`);
    }
    return lines.join('\n');
}

function formatCronSchedule(job: CronJob): string {
    return formatScheduleSummary(job.schedule);
}
