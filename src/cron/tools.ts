import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Config } from '../config.js';
import { getCronService } from './runtime.js';
import { getChannelConversationContext } from '../channels/context.js';
import { formatCronJob } from './format.js';

function resolveConversationDefaultDelivery(): { channel: string; target: string } | undefined {
    const context = getChannelConversationContext();
    if (!context) return undefined;

    if (context.channel !== 'dingtalk' && context.channel !== 'ios') {
        return undefined;
    }

    const target = context.isDirect
        ? context.senderId?.trim()
        : context.conversationId?.trim();

    if (!target) {
        return undefined;
    }

    return {
        channel: context.channel,
        target,
    };
}

function resolveCurrentChannel(): string | undefined {
    const context = getChannelConversationContext();
    if (!context) return undefined;
    const channel = context.channel?.trim().toLowerCase();
    if (!channel) return undefined;
    return channel;
}

function requireCronService() {
    const service = getCronService(resolveCurrentChannel()) || getCronService();
    if (!service) {
        throw new Error('Cron 服务未初始化，请在渠道服务启动后再试。');
    }
    return service;
}

export function createCronTools(_config: Config) {
    const cronListTool = tool(
        async ({ id }) => {
            const service = requireCronService();
            const status = service.getStatus();
            if (id?.trim()) {
                const job = await service.getJob(id);
                if (!job) return `❌ 未找到任务: ${id}`;
                return `✅ 定时任务详情\nservice: enabled=${status.enabled}, started=${status.started}, timezone=${status.timezone || 'n/a'}\n${formatCronJob(job)}`;
            }

            const jobs = await service.listJobs();
            if (jobs.length === 0) {
                return `📭 当前没有定时任务。\nservice: enabled=${status.enabled}, started=${status.started}, timezone=${status.timezone || 'n/a'}`;
            }
            const details = jobs.map((job) => formatCronJob(job)).join('\n\n');
            return `📋 定时任务列表（共 ${jobs.length} 个）\nservice: enabled=${status.enabled}, started=${status.started}, timezone=${status.timezone || 'n/a'}\n${details}`;
        },
        {
            name: 'cron_job_list',
            description: '查询定时任务。可查看所有任务，或按 id 查询单个任务详情。',
            schema: z.object({
                id: z.string().optional().describe('任务 ID，可选'),
            }),
        }
    );

    const cronAddTool = tool(
        async ({ name, description, message, scheduleKind, at, every, cronExpr, timezone, channel, target, enabled, title, useMarkdown }) => {
            const service = requireCronService();
            const fallbackDelivery = resolveConversationDefaultDelivery();
            const resolvedChannel = channel?.trim().toLowerCase() || fallbackDelivery?.channel;
            const resolvedTarget = target?.trim() || fallbackDelivery?.target;
            const schedule =
                scheduleKind === 'at'
                    ? { kind: 'at' as const, at: at || '' }
                    : scheduleKind === 'every'
                        ? { kind: 'every' as const, every: every || '' }
                        : { kind: 'cron' as const, expr: cronExpr || '', timezone };

            const job = await service.addJob({
                name,
                description,
                enabled,
                schedule,
                payload: {
                    message,
                },
                delivery: {
                    channel: resolvedChannel,
                    target: resolvedTarget,
                    title,
                    useMarkdown,
                },
            });
            return `✅ 定时任务已创建\n${formatCronJob(job)}`;
        },
        {
            name: 'cron_job_add',
            description: '创建定时任务（支持 at/every/cron），任务运行后会发送结果到目标渠道。',
            schema: z.object({
                name: z.string().describe('任务名称'),
                description: z.string().optional().describe('任务描述，可选'),
                message: z.string().describe('任务执行提示词（发送给模型）'),
                scheduleKind: z.enum(['at', 'every', 'cron']).describe('调度类型'),
                at: z.string().optional().describe('scheduleKind=at 时使用，ISO 时间，例如 2026-02-09T09:00:00+08:00'),
                every: z.union([z.string(), z.number()]).optional().describe('scheduleKind=every 时使用，例如 30m / 1h / 86400000'),
                cronExpr: z.string().optional().describe('scheduleKind=cron 时使用，5 段 cron 表达式'),
                timezone: z.string().optional().describe('时区，例如 Asia/Shanghai'),
                channel: z.string().optional().describe('发送渠道，可选：dingtalk / ios；默认取当前会话渠道'),
                target: z.string().optional().describe('发送目标。dingtalk: openConversationId/userId；ios: conversation:<id>/user:<id>/connection:<id>'),
                enabled: z.boolean().optional().describe('是否启用，默认 true'),
                title: z.string().optional().describe('推送标题，可选'),
                useMarkdown: z.boolean().optional().describe('是否使用 markdown 发送，可选'),
            }),
        }
    );

    const cronUpdateTool = tool(
        async ({ id, name, description, message, scheduleKind, at, every, cronExpr, timezone, channel, target, enabled, title, useMarkdown }) => {
            const service = requireCronService();
            const patch: {
                name?: string;
                description?: string;
                enabled?: boolean;
                schedule?: { kind: 'at'; at: string } | { kind: 'every'; every: string | number } | { kind: 'cron'; expr: string; timezone?: string };
                payload?: { message?: string };
                delivery?: { channel?: string; target?: string; title?: string; useMarkdown?: boolean };
            } = {};

            if (name !== undefined) patch.name = name;
            if (description !== undefined) patch.description = description;
            if (enabled !== undefined) patch.enabled = enabled;
            if (message !== undefined) patch.payload = { message };

            if (scheduleKind === 'at') {
                patch.schedule = { kind: 'at', at: at || '' };
            } else if (scheduleKind === 'every') {
                patch.schedule = { kind: 'every', every: every || '' };
            } else if (scheduleKind === 'cron') {
                patch.schedule = { kind: 'cron', expr: cronExpr || '', timezone };
            }

            if (channel !== undefined || target !== undefined || title !== undefined || useMarkdown !== undefined) {
                patch.delivery = {
                    channel: channel?.trim() || undefined,
                    target: target?.trim() || undefined,
                    title,
                    useMarkdown,
                };
            }

            const job = await service.updateJob(id, patch);
            return `✅ 定时任务已更新\n${formatCronJob(job)}`;
        },
        {
            name: 'cron_job_update',
            description: '更新定时任务（按 id）。仅提供需要修改的字段。',
            schema: z.object({
                id: z.string().describe('任务 ID'),
                name: z.string().optional().describe('新任务名称'),
                description: z.string().optional().describe('新描述'),
                message: z.string().optional().describe('新任务提示词'),
                scheduleKind: z.enum(['at', 'every', 'cron']).optional().describe('若要修改调度类型，必须提供'),
                at: z.string().optional().describe('scheduleKind=at 时使用'),
                every: z.union([z.string(), z.number()]).optional().describe('scheduleKind=every 时使用'),
                cronExpr: z.string().optional().describe('scheduleKind=cron 时使用'),
                timezone: z.string().optional().describe('cron 时区'),
                channel: z.string().optional().describe('发送渠道：dingtalk / ios'),
                target: z.string().optional().describe('新的发送目标'),
                enabled: z.boolean().optional().describe('是否启用'),
                title: z.string().optional().describe('推送标题'),
                useMarkdown: z.boolean().optional().describe('是否 markdown'),
            }),
        }
    );

    const cronDeleteTool = tool(
        async ({ id }) => {
            const service = requireCronService();
            const removed = await service.deleteJob(id);
            return removed ? `✅ 已删除定时任务: ${id}` : `❌ 未找到任务: ${id}`;
        },
        {
            name: 'cron_job_delete',
            description: '删除定时任务（按 id）。',
            schema: z.object({
                id: z.string().describe('任务 ID'),
            }),
        }
    );

    const cronRunNowTool = tool(
        async ({ id }) => {
            const service = requireCronService();
            const job = await service.triggerJobNow(id);
            const target = job.delivery.target || '默认目标';
            const channel = job.delivery.channel || '默认渠道';
            return `✅ 任务已开始后台执行: ${id}\nname: ${job.name}\nchannel: ${channel}\ntarget: ${target}\n结果会在执行完成后按任务配置发送；当前对话不会等待它跑完。`;
        },
        {
            name: 'cron_job_run_now',
            description: '立即在后台执行指定任务（按 id），当前对话不会同步等待任务完成。',
            schema: z.object({
                id: z.string().describe('任务 ID'),
            }),
        }
    );

    return [cronListTool, cronAddTool, cronUpdateTool, cronDeleteTool, cronRunNowTool];
}
