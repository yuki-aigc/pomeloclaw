import { tool } from '@langchain/core/tools';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { resolveMemoryScope } from './memory-scope.js';
import { getMemoryRuntime } from './memory-runtime.js';
import type { MemoryScope } from './memory-scope.js';

export interface TeamMemoryEntryInput {
    title?: string;
    summary?: string;
    applicability?: string;
    steps?: string[];
    constraints?: string[];
    evidence?: string[];
    tags?: string[];
    content?: string;
    sourceScope: MemoryScope;
    reason?: string;
    sourceScopes?: string[];
    reasons?: string[];
    updatedAt?: string;
}

interface TeamMemoryEntryRecord {
    title: string;
    summary: string;
    applicability: string;
    steps: string[];
    constraints: string[];
    evidence: string[];
    tags: string[];
    sourceScopes: string[];
    reasons: string[];
    updatedAt: string;
}

interface TeamMemoryBlockMatch {
    start: number;
    end: number;
    raw: string;
    record: TeamMemoryEntryRecord;
}

const TEAM_MEMORY_HEADING = '## 团队记忆条目';

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

function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatLocalDateTime(date: Date): string {
    return `${formatLocalDate(date)} ${date.toLocaleTimeString('zh-CN', { hour12: false })}`;
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
        '当信息需要沉淀为团队共享经验、标准流程、排障结论时，调用 memory_save_team 晋升到团队记忆（main scope），并优先填写结构化字段。',
        '若检索不足，请明确说明“已检索但信息不足”，不要臆造记忆。',
        '当用户纠正你、或你发现自己有可复盘错误时，调用 heartbeat_save 记录“触发场景/纠正动作/防回归要点”。',
    ].join('\n');
}

function resolveTeamMemoryScope(): MemoryScope {
    return {
        key: 'main',
        kind: 'main',
    };
}

export function buildTeamMemoryContent(params: {
    content: string;
    sourceScope: MemoryScope;
    reason?: string;
}): string {
    const normalized = params.content.trim();
    if (!normalized) {
        return normalized;
    }
    if (params.sourceScope.key === 'main') {
        return normalized;
    }

    const noteParts = [`来源scope=${params.sourceScope.key}`];
    const reason = params.reason?.trim();
    if (reason) {
        noteParts.push(`晋升原因=${reason}`);
    }

    return [`[团队记忆晋升] ${noteParts.join(' | ')}`, normalized].join('\n');
}

function normalizeList(items?: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const item of items || []) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(trimmed);
    }
    return normalized;
}

function inferTeamMemoryTitle(content: string, reason?: string): string {
    const firstLine = content
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || '';
    const sanitized = firstLine.replace(/^[-*#\s]+/u, '').trim();
    if (sanitized) {
        return sanitized.slice(0, 60);
    }
    return reason?.trim() ? `${reason.trim()}记录` : '团队经验记录';
}

export function buildStructuredTeamMemoryContent(params: TeamMemoryEntryInput): string {
    const fallbackContent = params.content?.trim() || '';
    const title = params.title?.trim() || inferTeamMemoryTitle(fallbackContent, params.reason);
    const summary = params.summary?.trim() || fallbackContent || '无';
    const applicability = params.applicability?.trim() || '无';
    const steps = normalizeList(params.steps);
    const constraints = normalizeList(params.constraints);
    const evidence = normalizeList(params.evidence);
    const tags = normalizeList(params.tags);
    const sourceScopes = normalizeList(params.sourceScopes || [params.sourceScope.key]);
    const reasons = normalizeList(params.reasons || (params.reason?.trim() ? [params.reason.trim()] : []));
    const updatedAt = params.updatedAt?.trim() || formatLocalDateTime(new Date());

    const body = [
        TEAM_MEMORY_HEADING,
        `- 标题: ${title}`,
        `- 来源scopes: ${sourceScopes.length > 0 ? sourceScopes.join(' / ') : '无'}`,
        `- 晋升原因: ${reasons.length > 0 ? reasons.join(' / ') : '无'}`,
        `- 更新时间: ${updatedAt}`,
        tags.length > 0 ? `- 标签: ${tags.join(' / ')}` : '- 标签: 无',
        '',
        '### 摘要',
        summary,
        '',
        '### 适用场景',
        applicability,
        '',
        '### 操作步骤',
        steps.length > 0
            ? steps.map((step, index) => `${index + 1}. ${step}`).join('\n')
            : '无',
        '',
        '### 边界与注意事项',
        constraints.length > 0
            ? constraints.map((item) => `- ${item}`).join('\n')
            : '无',
        '',
        '### 证据与依据',
        evidence.length > 0
            ? evidence.map((item) => `- ${item}`).join('\n')
            : '无',
    ];

    return body.join('\n');
}

function extractSection(block: string, title: string): string {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^### ${escapedTitle}\\n([\\s\\S]*?)(?=^### |^## |$)`, 'm');
    const match = block.match(pattern);
    return match?.[1]?.trim() || '无';
}

function parseListSection(section: string): string[] {
    const text = section.trim();
    if (!text || text === '无') {
        return [];
    }
    return normalizeList(
        text
            .split('\n')
            .map((line) => line.replace(/^[-*]\s+/u, '').replace(/^\d+\.\s+/u, '').trim())
            .filter(Boolean),
    );
}

function parseMetaListLine(block: string, label: string): string[] {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineMatch = block.match(new RegExp(`^- ${escapedLabel}:\\s*(.+)$`, 'm'));
    const value = lineMatch?.[1]?.trim() || '';
    if (!value || value === '无') {
        return [];
    }
    return normalizeList(value.split('/').map((item) => item.trim()));
}

function parseLegacyMeta(block: string): { sourceScopes: string[]; reasons: string[] } {
    const legacyLine = block.match(/^- 来源scope=([^\n|]+)(?:\s+\|\s+晋升原因=([^\n]+))?$/m);
    return {
        sourceScopes: legacyLine?.[1] ? normalizeList([legacyLine[1].trim()]) : [],
        reasons: legacyLine?.[2] ? normalizeList([legacyLine[2].trim()]) : [],
    };
}

function parseTeamMemoryRecord(block: string): TeamMemoryEntryRecord {
    const titleMatch = block.match(/^- 标题:\s*(.+)$/m);
    const title = titleMatch?.[1]?.trim() || '团队经验记录';
    const updatedAtMatch = block.match(/^- 更新时间:\s*(.+)$/m);
    const legacyMeta = parseLegacyMeta(block);

    return {
        title,
        summary: extractSection(block, '摘要'),
        applicability: extractSection(block, '适用场景'),
        steps: parseListSection(extractSection(block, '操作步骤')),
        constraints: parseListSection(extractSection(block, '边界与注意事项')),
        evidence: parseListSection(extractSection(block, '证据与依据')),
        tags: parseMetaListLine(block, '标签'),
        sourceScopes: normalizeList([...parseMetaListLine(block, '来源scopes'), ...legacyMeta.sourceScopes]),
        reasons: normalizeList([...parseMetaListLine(block, '晋升原因'), ...legacyMeta.reasons]),
        updatedAt: updatedAtMatch?.[1]?.trim() || '',
    };
}

function parseTeamMemoryBlocks(content: string): TeamMemoryBlockMatch[] {
    const matches = Array.from(content.matchAll(/^## 团队记忆条目$/gm));
    if (matches.length === 0) {
        return [];
    }

    return matches.map((match, index) => {
        const start = match.index ?? 0;
        const end = index + 1 < matches.length
            ? (matches[index + 1]?.index ?? content.length)
            : content.length;
        const raw = content.slice(start, end).trimEnd();
        return {
            start,
            end,
            raw,
            record: parseTeamMemoryRecord(raw),
        };
    });
}

function mergeTextSection(existing: string, incoming: string): string {
    const a = existing.trim();
    const b = incoming.trim();
    if (!a || a === '无') return b || '无';
    if (!b || b === '无') return a || '无';
    if (a === b) return a;
    if (a.includes(b)) return a;
    if (b.includes(a)) return b;
    return `${a}\n\n补充：${b}`;
}

function mergeTeamMemoryRecords(existing: TeamMemoryEntryRecord, incoming: TeamMemoryEntryRecord): TeamMemoryEntryRecord {
    return {
        title: incoming.title || existing.title,
        summary: mergeTextSection(existing.summary, incoming.summary),
        applicability: mergeTextSection(existing.applicability, incoming.applicability),
        steps: normalizeList([...existing.steps, ...incoming.steps]),
        constraints: normalizeList([...existing.constraints, ...incoming.constraints]),
        evidence: normalizeList([...existing.evidence, ...incoming.evidence]),
        tags: normalizeList([...existing.tags, ...incoming.tags]),
        sourceScopes: normalizeList([...existing.sourceScopes, ...incoming.sourceScopes]),
        reasons: normalizeList([...existing.reasons, ...incoming.reasons]),
        updatedAt: formatLocalDateTime(new Date()),
    };
}

function buildMemoryFileHeader(target: 'daily' | 'long-term', scope: MemoryScope, date: Date): string {
    return target === 'daily'
        ? `# Daily Memory - ${formatLocalDate(date)} (${scope.key})\n`
        : `# Long-term Memory (${scope.key})\n\n`;
}

function resolveTeamTargetPath(workspacePath: string, target: 'daily' | 'long-term', date: Date): string {
    return target === 'daily'
        ? join(workspacePath, 'memory', `${formatLocalDate(date)}.md`)
        : join(workspacePath, 'MEMORY.md');
}

async function upsertTeamMemoryEntry(params: {
    workspacePath: string;
    runtime: Awaited<ReturnType<typeof getMemoryRuntime>>;
    target: 'daily' | 'long-term';
    content: string;
    title: string;
}): Promise<string> {
    const now = new Date();
    const scope = resolveTeamMemoryScope();
    const targetPath = resolveTeamTargetPath(params.workspacePath, params.target, now);

    await mkdir(dirname(targetPath), { recursive: true });

    const existing = await readFile(targetPath, 'utf-8').catch(() => '');
    const baseContent = existing || buildMemoryFileHeader(params.target, scope, now);
    const blocks = parseTeamMemoryBlocks(baseContent);
    const incoming = parseTeamMemoryRecord(params.content);
    const sameTitle = blocks.find((block) => block.record.title === params.title);

    let nextContent: string;
    if (!sameTitle) {
        const trimmedBase = baseContent.trimEnd();
        nextContent = `${trimmedBase}${trimmedBase.endsWith('\n\n') ? '' : '\n\n'}${params.content.trim()}\n`;
    } else {
        const merged = buildStructuredTeamMemoryContent({
            ...mergeTeamMemoryRecords(sameTitle.record, incoming),
            sourceScope: scope,
        });
        nextContent = `${baseContent.slice(0, sameTitle.start)}${merged}\n${baseContent.slice(sameTitle.end).replace(/^\s+/u, '')}`;
    }

    await writeFile(targetPath, nextContent, 'utf-8');
    if (params.runtime.canUsePg()) {
        await params.runtime.syncIncremental({ onlyPaths: [targetPath], force: true });
    }
    return targetPath;
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

    const memorySaveTeam = tool(
        async ({
            target,
            reason,
            title,
            summary,
            applicability,
            steps,
            constraints,
            evidence,
            tags,
            content,
        }: {
            target: 'daily' | 'long-term';
            reason?: string;
            title?: string;
            summary?: string;
            applicability?: string;
            steps?: string[];
            constraints?: string[];
            evidence?: string[];
            tags?: string[];
            content?: string;
        }) => {
            const sourceScope = resolveMemoryScope(config.agent.memory.session_isolation);
            const runtime = await runtimePromise;
            const promotedContent = buildStructuredTeamMemoryContent({
                title,
                summary,
                applicability,
                steps,
                constraints,
                evidence,
                tags,
                content,
                sourceScope,
                reason,
            });
            const normalizedTitle = parseTeamMemoryRecord(promotedContent).title;
            const targetPath = await upsertTeamMemoryEntry({
                workspacePath,
                runtime,
                target,
                content: promotedContent,
                title: normalizedTitle,
            });
            return `已晋升到团队记忆: ${targetPath} (scope=main, from=${sourceScope.key}, title=${normalizedTitle})`;
        },
        {
            name: 'memory_save_team',
            description: '将可复用的经验、标准流程、排障结论、稳定事实晋升到团队共享记忆（main scope）。优先填写结构化字段（标题、摘要、适用场景、步骤、边界、证据、标签）；仅在缺少结构信息时再退回 content。',
            schema: z.object({
                target: z.enum(['daily', 'long-term']).describe('目标: daily(团队今日记忆) 或 long-term(团队长期记忆)'),
                reason: z.string().optional().describe('晋升原因，例如 标准流程/通用排障经验/团队共识'),
                title: z.string().optional().describe('团队记忆标题，建议一句话概括'),
                summary: z.string().optional().describe('核心摘要，说明结论或经验本身'),
                applicability: z.string().optional().describe('适用场景，例如 哪类问题/什么条件下应使用'),
                steps: z.array(z.string()).optional().describe('建议执行步骤，按顺序列出'),
                constraints: z.array(z.string()).optional().describe('边界条件、风险、注意事项'),
                evidence: z.array(z.string()).optional().describe('依据或证据，例如 来自哪个案例/观察/日志结论'),
                tags: z.array(z.string()).optional().describe('标签，例如 排障流程/告警/数据库'),
                content: z.string().optional().describe('兼容字段：当无法提供结构化字段时，可提供原始内容，系统会自动包装成结构化条目'),
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

    return [memorySave, memorySaveTeam, memorySearch, memoryGet, heartbeatSave];
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
