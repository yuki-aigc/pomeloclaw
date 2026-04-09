import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

type BootstrapFileName = 'AGENTS.md' | 'AGENT.md' | 'SOUL.md' | 'TOOLS.md' | 'HEARTBEAT.md' | 'MEMORY.md' | 'LONG_TERM.md';
type BootstrapFileScope = 'global' | 'scope';
type BootstrapTopic = 'agents' | 'tools' | 'soul' | 'heartbeat' | 'memory';

interface LoadedBootstrapFile {
    topic: BootstrapTopic;
    name: BootstrapFileName;
    absPath: string;
    relPath: string;
    scope: BootstrapFileScope;
    missing: boolean;
    truncated: boolean;
    content: string;
}

interface BootstrapFileCandidate {
    topic: BootstrapTopic;
    name: BootstrapFileName;
    absPath: string;
    scope: BootstrapFileScope;
}

const MIN_BOOTSTRAP_CHARS = 200;
const MAX_BOOTSTRAP_CHARS = 20_000;
const DEFAULT_BOOTSTRAP_FILE_MAX_CHARS = 4000;
const MIN_BOOTSTRAP_TOTAL_CHARS = 1000;
const MAX_BOOTSTRAP_TOTAL_CHARS = 60_000;
const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 12_000;
const MIN_MEMORY_SECTION_CHARS = 300;
const MAX_MEMORY_SECTION_CHARS = 6000;
const DEFAULT_MEMORY_SECTION_MIN_CHARS = 1800;
const INCLUDE_MISSING_FILE_MARKERS = true;
const INCLUDE_TOOLS_MD = true;
const INCLUDE_HEARTBEAT_MD = true;
const INCLUDE_MEMORY_MD = true;
const SCOPE_SOUL_ENABLED = true;
const SCOPE_TOOLS_ENABLED = true;
const SCOPE_HEARTBEAT_ENABLED = true;

function sanitizeScopePathSegment(scopeKey: string): string {
    const normalized = scopeKey.trim().toLowerCase();
    if (!normalized) {
        return 'main';
    }
    return normalized.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'main';
}

function clipInjectedText(content: string, maxChars: number): { text: string; truncated: boolean } {
    const normalized = content.replace(/\r\n/g, '\n').trim();
    if (maxChars <= 0) {
        return {
            text: '',
            truncated: normalized.length > 0,
        };
    }
    if (normalized.length <= maxChars) {
        return { text: normalized, truncated: false };
    }
    if (maxChars === 1) {
        return { text: '…', truncated: true };
    }
    return {
        text: `${normalized.slice(0, Math.max(0, maxChars - 1))}…`,
        truncated: true,
    };
}

function getBootstrapFileMaxChars(): number {
    return Math.max(MIN_BOOTSTRAP_CHARS, Math.min(MAX_BOOTSTRAP_CHARS, DEFAULT_BOOTSTRAP_FILE_MAX_CHARS));
}

function getBootstrapTotalMaxChars(): number {
    return Math.max(MIN_BOOTSTRAP_TOTAL_CHARS, Math.min(MAX_BOOTSTRAP_TOTAL_CHARS, DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS));
}

function getMemorySectionMinChars(): number {
    return Math.max(MIN_MEMORY_SECTION_CHARS, Math.min(MAX_MEMORY_SECTION_CHARS, DEFAULT_MEMORY_SECTION_MIN_CHARS));
}

function buildScopedCandidates(
    workspacePath: string,
    scopeKey: string,
    topic: BootstrapTopic,
    fileName: BootstrapFileName,
    scopeEnabled: boolean,
): BootstrapFileCandidate[] {
    const candidates: BootstrapFileCandidate[] = [];
    if (scopeEnabled) {
        const safeScopeKey = sanitizeScopePathSegment(scopeKey);
        candidates.push({
            topic,
            name: fileName,
            absPath: join(workspacePath, 'memory', 'scopes', safeScopeKey, fileName),
            scope: 'scope',
        });
    }

    candidates.push({
        topic,
        name: fileName,
        absPath: join(workspacePath, fileName),
        scope: 'global',
    });

    return candidates;
}

async function readBootstrapFile(params: {
    topic: BootstrapTopic;
    name: BootstrapFileName;
    absPath: string;
    scope: BootstrapFileScope;
    workspacePath: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    const relPath = relative(params.workspacePath, params.absPath).replace(/\\/g, '/');
    if (!existsSync(params.absPath)) {
        if (!params.includeMissingFileMarkers) {
            return null;
        }
        return {
            topic: params.topic,
            name: params.name,
            absPath: params.absPath,
            relPath,
            scope: params.scope,
            missing: true,
            truncated: false,
            content: `(文件缺失) ${relPath}`,
        };
    }

    const raw = await readFile(params.absPath, 'utf-8');
    const clipped = clipInjectedText(raw, params.maxChars);
    if (!clipped.text) {
        if (!params.includeMissingFileMarkers) {
            return null;
        }
        return {
            topic: params.topic,
            name: params.name,
            absPath: params.absPath,
            relPath,
            scope: params.scope,
            missing: true,
            truncated: false,
            content: `(文件为空) ${relPath}`,
        };
    }

    return {
        topic: params.topic,
        name: params.name,
        absPath: params.absPath,
        relPath,
        scope: params.scope,
        missing: false,
        truncated: clipped.truncated,
        content: clipped.text,
    };
}

function pickCandidate(candidates: BootstrapFileCandidate[]): BootstrapFileCandidate | null {
    if (candidates.length === 0) {
        return null;
    }
    const firstExisting = candidates.find((candidate) => existsSync(candidate.absPath));
    return firstExisting || candidates[0];
}

function buildBootstrapSectionMeta(file: LoadedBootstrapFile): string {
    return [
        `path=${file.relPath}`,
        `name=${file.name}`,
        `scope=${file.scope}`,
        `missing=${file.missing ? 'true' : 'false'}`,
        `truncated=${file.truncated ? 'true' : 'false'}`,
    ].join(', ');
}

function formatBootstrapSection(file: LoadedBootstrapFile, content?: string): string {
    const title = file.topic.toUpperCase();
    const sectionContent = typeof content === 'string' ? content : file.content;
    const meta = buildBootstrapSectionMeta(file);

    return [
        `## ${title}`,
        `[${meta}]`,
        sectionContent,
    ].join('\n');
}

function getBootstrapSectionFrameChars(file: LoadedBootstrapFile): number {
    return formatBootstrapSection(file, '').length;
}

function getBootstrapTopicWeight(topic: BootstrapTopic): number {
    switch (topic) {
    case 'memory':
        return 3.5;
    case 'agents':
        return 1.7;
    case 'tools':
        return 1.2;
    case 'soul':
        return 1;
    case 'heartbeat':
        return 1;
    default:
        return 1;
    }
}

function allocateBodyContentBudgets(
    files: LoadedBootstrapFile[],
    availableChars: number,
    memoryMinChars: number,
): number[] {
    const budgets = files.map(() => 0);
    if (availableChars <= 0 || files.length === 0) {
        return budgets;
    }

    const lengths = files.map((file) => file.content.length);
    const totalContentChars = lengths.reduce((sum, size) => sum + size, 0);
    if (totalContentChars <= availableChars) {
        return [...lengths];
    }

    const memoryIndex = files.findIndex((file) => file.topic === 'memory');
    if (memoryIndex >= 0) {
        const targetFloor = Math.min(memoryMinChars, lengths[memoryIndex], availableChars);
        budgets[memoryIndex] = Math.max(0, targetFloor);
    }

    let remaining = availableChars - budgets.reduce((sum, size) => sum + size, 0);
    if (remaining <= 0) {
        return budgets;
    }

    const pending = new Set<number>();
    for (let i = 0; i < files.length; i += 1) {
        const need = lengths[i] - budgets[i];
        if (need > 0) {
            pending.add(i);
        }
    }

    while (remaining > 0 && pending.size > 0) {
        let totalWeight = 0;
        for (const index of pending) {
            totalWeight += getBootstrapTopicWeight(files[index].topic);
        }

        if (totalWeight <= 0) {
            break;
        }

        let distributed = 0;
        for (const index of pending) {
            const need = lengths[index] - budgets[index];
            if (need <= 0) {
                continue;
            }
            const share = Math.max(1, Math.floor((remaining * getBootstrapTopicWeight(files[index].topic)) / totalWeight));
            const grant = Math.min(need, share, remaining - distributed);
            if (grant <= 0) {
                continue;
            }
            budgets[index] += grant;
            distributed += grant;
            if (budgets[index] >= lengths[index]) {
                pending.delete(index);
            }
            if (distributed >= remaining) {
                break;
            }
        }

        if (distributed <= 0) {
            break;
        }
        remaining -= distributed;
    }

    return budgets;
}

function applyBootstrapBodyBudget(
    files: LoadedBootstrapFile[],
    options: {
        bodyMaxChars: number;
        memoryMinChars: number;
    },
): LoadedBootstrapFile[] {
    if (files.length === 0) {
        return [];
    }

    if (options.bodyMaxChars <= 0) {
        return files.map((file) => ({
            ...file,
            content: '',
            truncated: file.truncated || file.content.length > 0,
        }));
    }

    const separatorChars = (files.length - 1) * 2;
    const frameChars = files.reduce((sum, file) => sum + getBootstrapSectionFrameChars(file), 0);
    const contentBudget = Math.max(0, options.bodyMaxChars - separatorChars - frameChars);
    const contentBudgets = allocateBodyContentBudgets(files, contentBudget, options.memoryMinChars);

    return files.map((file, index) => {
        const clipped = clipInjectedText(file.content, contentBudgets[index] ?? 0);
        return {
            ...file,
            content: clipped.text,
            truncated: file.truncated || clipped.truncated,
        };
    });
}

async function loadAgentsFile(params: {
    workspacePath: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    const candidates: BootstrapFileCandidate[] = [
        {
            topic: 'agents',
            name: 'AGENTS.md',
            absPath: join(params.workspacePath, 'AGENTS.md'),
            scope: 'global',
        },
        {
            topic: 'agents',
            name: 'AGENT.md',
            absPath: join(params.workspacePath, 'AGENT.md'),
            scope: 'global',
        },
    ];
    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

async function loadSoulFile(params: {
    workspacePath: string;
    scopeKey: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    const candidates = buildScopedCandidates(
        params.workspacePath,
        params.scopeKey,
        'soul',
        'SOUL.md',
        SCOPE_SOUL_ENABLED,
    );
    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

async function loadToolsFile(params: {
    workspacePath: string;
    scopeKey: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    if (!INCLUDE_TOOLS_MD) {
        return null;
    }

    const candidates = buildScopedCandidates(
        params.workspacePath,
        params.scopeKey,
        'tools',
        'TOOLS.md',
        SCOPE_TOOLS_ENABLED,
    );
    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

async function loadHeartbeatFile(params: {
    workspacePath: string;
    scopeKey: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    if (!INCLUDE_HEARTBEAT_MD) {
        return null;
    }

    const candidates = buildScopedCandidates(
        params.workspacePath,
        params.scopeKey,
        'heartbeat',
        'HEARTBEAT.md',
        SCOPE_HEARTBEAT_ENABLED,
    );
    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

async function loadMemoryFile(params: {
    workspacePath: string;
    scopeKey: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    if (!INCLUDE_MEMORY_MD) {
        return null;
    }

    const safeScopeKey = sanitizeScopePathSegment(params.scopeKey);
    const candidates: BootstrapFileCandidate[] = [
        {
            topic: 'memory',
            name: 'MEMORY.md',
            absPath: join(params.workspacePath, 'memory', 'scopes', safeScopeKey, 'MEMORY.md'),
            scope: 'scope',
        },
        // Legacy fallback to keep old data readable during path migration.
        {
            topic: 'memory',
            name: 'LONG_TERM.md',
            absPath: join(params.workspacePath, 'memory', 'scopes', safeScopeKey, 'LONG_TERM.md'),
            scope: 'scope',
        },
    ];
    if (safeScopeKey === 'main') {
        candidates.push({
            topic: 'memory',
            name: 'MEMORY.md',
            absPath: join(params.workspacePath, 'MEMORY.md'),
            scope: 'global',
        });
    }

    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

export async function buildPromptBootstrapMessage(params: {
    workspacePath: string;
    scopeKey: string;
}): Promise<{ role: 'user'; content: string } | null> {
    const maxChars = getBootstrapFileMaxChars();
    const includeMissingFileMarkers = INCLUDE_MISSING_FILE_MARKERS;

    const [agentsFile, toolsFile, soulFile, heartbeatFile, memoryFile] = await Promise.all([
        loadAgentsFile({
            workspacePath: params.workspacePath,
            maxChars,
            includeMissingFileMarkers,
        }),
        loadToolsFile({
            workspacePath: params.workspacePath,
            scopeKey: params.scopeKey,
            maxChars,
            includeMissingFileMarkers,
        }),
        loadSoulFile({
            workspacePath: params.workspacePath,
            scopeKey: params.scopeKey,
            maxChars,
            includeMissingFileMarkers,
        }),
        loadHeartbeatFile({
            workspacePath: params.workspacePath,
            scopeKey: params.scopeKey,
            maxChars,
            includeMissingFileMarkers,
        }),
        loadMemoryFile({
            workspacePath: params.workspacePath,
            scopeKey: params.scopeKey,
            maxChars,
            includeMissingFileMarkers,
        }),
    ]);

    const files = [agentsFile, toolsFile, soulFile, heartbeatFile, memoryFile].filter((item): item is LoadedBootstrapFile => Boolean(item));
    if (files.length === 0) {
        return null;
    }

    const header = [
        '【Prompt Bootstrap / 系统上下文转述】',
        '以下内容来自工作区 Markdown 引导文件（参考 智能体 的多文件注入思路）。',
        '规则优先级（高 -> 低）：',
        '1) 平台与运行时硬约束（安全策略、审批、工具白名单/黑名单）',
        '2) 系统提示词中的硬规则',
        '3) 用户当前任务目标与明确约束',
        '4) AGENTS（项目协作与执行规范）',
        '5) TOOLS（工具使用约定）',
        '6) SOUL（身份、语气、偏好边界；可 scope 覆盖）',
        '7) HEARTBEAT（纠错与复盘经验；可 scope 覆盖）',
        '8) MEMORY（长期/关键记忆事实；按 scope 注入）',
        '冲突处理：安全/边界冲突按高优先级执行；若仅为风格冲突，优先满足用户当前任务并在 HEARTBEAT 记录纠偏经验。',
    ].join('\n');

    const bodyBudget = Math.max(0, getBootstrapTotalMaxChars() - header.length - 2);
    const budgetedFiles = applyBootstrapBodyBudget(files, {
        bodyMaxChars: bodyBudget,
        memoryMinChars: getMemorySectionMinChars(),
    });
    const body = budgetedFiles.map((file) => formatBootstrapSection(file)).join('\n\n');
    return {
        role: 'user',
        content: `${header}\n\n${body}`,
    };
}
