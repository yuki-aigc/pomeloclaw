import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Config } from '../config.js';
import { resolveMemoryScope } from './memory-scope.js';
import { getMemoryRuntime } from './memory-runtime.js';

function clampInjectedMemoryText(text: string, maxChars: number): string {
    const normalized = text ?? '';
    const budget = Math.max(1, Math.floor(maxChars));
    if (normalized.length <= budget) {
        return normalized;
    }

    const suffix = `\n...[memory output truncated at ${budget} chars]`;
    if (suffix.length >= budget) {
        return normalized.slice(0, budget);
    }
    const head = normalized.slice(0, budget - suffix.length).trimEnd();
    return `${head}${suffix}`;
}

/**
 * Load memory context for system prompt injection.
 *
 * To avoid cross-session leakage (main/group), memory now defaults to tool-based retrieval
 * instead of inlining daily memory content in the static system prompt.
 */
export function loadMemoryContext(workspacePath: string): string {
    void workspacePath;
    return [
        '记忆采用按需检索模式。',
        '当用户询问“你还记得吗/之前/上次/今天/昨天/我们聊过什么”等历史回溯问题时，先调用 memory_search。',
        '当需要精确引用记忆（数字、日期、阈值、原话）时，先 memory_search，再用 memory_get 读取命中片段。',
        '若检索不足，请明确说明“已检索但信息不足”，不要臆造记忆。',
        '当用户纠正你、或你发现自己有可复盘错误时，调用 heartbeat_save 记录“触发场景/纠正动作/防回归要点”。',
    ].join('\n');
}

/**
 * Create memory-specific tools
 */
export function createMemoryTools(workspacePath: string, config: Config) {
    const runtimePromise = getMemoryRuntime(workspacePath, config);
    const maxInjectedChars = config.agent.memory.retrieval.max_injected_chars;

    const memorySave = tool(
        async ({ content, target }: { content: string; target: 'daily' | 'long-term' }) => {
            const scope = resolveMemoryScope(config.agent.memory.session_isolation);
            const runtime = await runtimePromise;
            const result = await runtime.save(content, target, scope);
            return `已保存到记忆: ${result.path} (scope=${result.scope})`;
        },
        {
            name: 'memory_save',
            description: '保存重要信息到记忆系统。支持按会话隔离（main/group/direct）。使用 "daily" 存储今日笔记，使用 "long-term" 存储长期信息。',
            schema: z.object({
                content: z.string().describe('要保存的记忆内容'),
                target: z.enum(['daily', 'long-term']).describe('目标: daily(每日记忆) 或 long-term(长期记忆)'),
            }),
        }
    );

    const memorySearch = tool(
        async ({ query }: { query: string }) => {
            const scope = resolveMemoryScope(config.agent.memory.session_isolation);
            const runtime = await runtimePromise;
            const hits = await runtime.search(query, scope);

            if (hits.length === 0) {
                return `未找到与 "${query}" 相关的记忆（scope=${scope.key}）`;
            }

            const lines = hits
                .slice(0, config.agent.memory.retrieval.max_results)
                .map((item, index) => {
                    const score = Number.isFinite(item.score) ? item.score.toFixed(3) : '0.000';
                    return [
                        `${index + 1}. [${item.path}:${item.startLine}] score=${score} source=${item.source} strategy=${item.strategy}`,
                        `   ${item.snippet}`,
                    ].join('\n');
                });

            return clampInjectedMemoryText([
                `找到 ${hits.length} 条相关记忆（scope=${scope.key}）:`,
                ...lines,
            ].join('\n'), maxInjectedChars);
        },
        {
            name: 'memory_search',
            description: '在当前会话作用域的记忆中搜索（支持 keyword/fts/vector/hybrid），返回 path/行号供 memory_get 精读',
            schema: z.object({
                query: z.string().describe('搜索关键词或语义查询'),
            }),
        }
    );

    const memoryGet = tool(
        async ({ path, from, lines }: { path: string; from?: number; lines?: number }) => {
            const scope = resolveMemoryScope(config.agent.memory.session_isolation);
            const runtime = await runtimePromise;
            const result = await runtime.get(path, { from, lines }, scope);
            const meta = [
                `已读取记忆片段: ${result.path}`,
                `(scope=${result.scope}, source=${result.source}, from=${result.fromLine}, lines=${result.lineCount}, to=${result.toLine}${result.truncated ? ', truncated=true' : ''})`,
            ].join(' ');
            return clampInjectedMemoryText(`${meta}\n${result.text || '(空结果)'}`, maxInjectedChars);
        },
        {
            name: 'memory_get',
            description: '按 path 精读记忆片段（建议先 memory_search）。支持 MEMORY.md / HEARTBEAT.md / memory/**/*.md / session_events 路径，可选 from/lines。',
            schema: z.object({
                path: z.string().describe('要读取的记忆路径，建议直接使用 memory_search 返回的 path'),
                from: z.number().int().min(1).optional().describe('起始行号（从 1 开始），默认 1'),
                lines: z.number().int().min(1).max(300).optional().describe('读取行数，默认 40，最大 300'),
            }),
        }
    );

    const heartbeatSave = tool(
        async ({ content, category }: { content: string; category?: string }) => {
            const scope = resolveMemoryScope(config.agent.memory.session_isolation);
            const runtime = await runtimePromise;
            const result = await runtime.saveHeartbeat(content, scope, category);
            return `已保存到 HEARTBEAT: ${result.path} (scope=${result.scope})`;
        },
        {
            name: 'heartbeat_save',
            description: '保存纠错复盘与行为改进要点到 HEARTBEAT.md（按会话 scope 隔离）。建议内容包含触发场景、纠正动作、防回归检查。',
            schema: z.object({
                content: z.string().describe('要记录的纠错/复盘内容'),
                category: z.string().optional().describe('分类标签，例如 incident/process/style/safety'),
            }),
        }
    );

    return [memorySave, memorySearch, memoryGet, heartbeatSave];
}

export type SessionEventRole = 'user' | 'assistant' | 'summary';

export async function recordSessionEvent(
    workspacePath: string,
    config: Config,
    params: {
        role: SessionEventRole;
        content: string;
        conversationId: string;
        channel?: string;
        createdAt?: number;
        metadata?: Record<string, unknown>;
        fallbackToTranscript?: boolean;
    },
): Promise<'pg' | 'transcript' | 'skipped'> {
    const text = params.content.trim();
    if (!text) {
        return 'skipped';
    }

    const scope = resolveMemoryScope(config.agent.memory.session_isolation);
    const runtime = await getMemoryRuntime(workspacePath, config);

    try {
        const persisted = await runtime.appendSessionEvent({
            scope,
            conversationId: params.conversationId,
            role: params.role,
            content: text,
            channel: params.channel,
            createdAt: params.createdAt,
            metadata: params.metadata,
        });
        if (persisted) {
            return 'pg';
        }
    } catch {
        // fall through to transcript fallback when enabled
    }

    if (params.fallbackToTranscript === false) {
        return 'skipped';
    }

    if (params.role === 'summary') {
        await runtime.appendTranscript(scope, 'assistant', `[压缩摘要] ${text}`);
        return 'transcript';
    }

    await runtime.appendTranscript(scope, params.role === 'assistant' ? 'assistant' : 'user', text);
    return 'transcript';
}

export async function recordSessionTranscript(
    workspacePath: string,
    config: Config,
    role: 'user' | 'assistant',
    content: string,
): Promise<void> {
    const scope = resolveMemoryScope(config.agent.memory.session_isolation);
    const runtime = await getMemoryRuntime(workspacePath, config);
    await runtime.appendTranscript(scope, role, content);
}
