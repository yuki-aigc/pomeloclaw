import type { InstalledSkillSummary } from '../../skills/manager.js';

export interface RequestedWebSkillFields {
    skills?: unknown;
    skill_names?: unknown;
    skillNames?: unknown;
}

export interface ResolvedWebSkillSelection {
    requested: string[];
    selected: string[];
    unknown: string[];
}

function normalizeSkillToken(input: string): string {
    return input
        .trim()
        .toLowerCase()
        .replace(/^@+/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function collectStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const results: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') {
            continue;
        }
        const normalized = normalizeSkillToken(item);
        if (normalized) {
            results.push(normalized);
        }
    }
    return results;
}

export function collectRequestedWebSkills(payload: RequestedWebSkillFields): string[] {
    const requested = [
        ...collectStringArray(payload.skills),
        ...collectStringArray(payload.skill_names),
        ...collectStringArray(payload.skillNames),
    ];

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const item of requested) {
        if (seen.has(item)) {
            continue;
        }
        seen.add(item);
        unique.push(item);
    }
    return unique;
}

export function resolveRequestedWebSkills(
    requested: string[],
    availableSkills: InstalledSkillSummary[],
): ResolvedWebSkillSelection {
    const aliases = new Map<string, string>();
    for (const skill of availableSkills) {
        aliases.set(normalizeSkillToken(skill.name), skill.name);
        aliases.set(normalizeSkillToken(skill.dirName), skill.name);
    }

    const selected: string[] = [];
    const unknown: string[] = [];
    const seenSelected = new Set<string>();

    for (const item of requested) {
        const matched = aliases.get(normalizeSkillToken(item));
        if (!matched) {
            unknown.push(item);
            continue;
        }
        if (seenSelected.has(matched)) {
            continue;
        }
        seenSelected.add(matched);
        selected.push(matched);
    }

    return {
        requested: [...requested],
        selected,
        unknown,
    };
}

export function buildSelectedSkillsInstruction(selectedSkills: string[]): string {
    if (selectedSkills.length === 0) {
        return '';
    }

    return [
        '[技能选择]',
        '以下 skills 由用户在 Web 前端显式选中；请优先按这些 skill 的能力与约束完成本轮任务，不要忽略：',
        ...selectedSkills.map((skill) => `- ${skill}`),
    ].join('\n');
}
