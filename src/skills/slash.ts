import {
    formatInstalledSkills,
    formatSkillInstallResult,
    formatSkillRemoveResult,
    installSkillFromSource,
    listInstalledSkills,
    removeInstalledSkill,
} from './manager.js';

export type SkillSlashCommand =
    | { type: 'list' }
    | { type: 'install'; source: string }
    | { type: 'remove'; skillName: string }
    | { type: 'reload' };

export interface SkillSlashExecutorParams {
    input: string;
    skillsDir: string;
    reloadAgent: () => Promise<void>;
}

export function parseSkillSlashCommand(input: string): SkillSlashCommand | null {
    const text = input.trim();
    if (text === '/skills') {
        return { type: 'list' };
    }
    if (text === '/skill-reload') {
        return { type: 'reload' };
    }
    if (text === '/skill-remove') {
        return { type: 'remove', skillName: '' };
    }
    if (text === '/skill-install') {
        return { type: 'install', source: '' };
    }
    if (text.startsWith('/skill-remove ')) {
        return {
            type: 'remove',
            skillName: text.slice('/skill-remove'.length).trim(),
        };
    }
    if (text.startsWith('/skill-install ')) {
        return {
            type: 'install',
            source: text.slice('/skill-install'.length).trim(),
        };
    }
    return null;
}

export function getSkillHelpLines(): string[] {
    return [
        '/skills - 列出当前已安装技能',
        '/skill-install <来源> - 远程或本地安装技能',
        '/skill-remove <名称> - 删除已安装技能',
        '/skill-reload - 重新加载技能索引',
    ];
}

export async function executeSkillSlashCommand(params: SkillSlashExecutorParams): Promise<{ handled: boolean; response?: string }> {
    const command = parseSkillSlashCommand(params.input);
    if (!command) {
        return { handled: false };
    }

    if (command.type === 'list') {
        const skills = await listInstalledSkills(params.skillsDir);
        return {
            handled: true,
            response: formatInstalledSkills(skills),
        };
    }

    if (command.type === 'reload') {
        await params.reloadAgent();
        return {
            handled: true,
            response: '✅ 技能索引已重新加载。',
        };
    }

    if (command.type === 'remove') {
        if (!command.skillName) {
            return {
                handled: true,
                response: 'ℹ️ 用法: /skill-remove <技能名称>',
            };
        }

        const result = await removeInstalledSkill({
            skillsDir: params.skillsDir,
            skillName: command.skillName,
        });
        await params.reloadAgent();
        return {
            handled: true,
            response: `${formatSkillRemoveResult(result)}\n\n✅ 技能索引已热重载。`,
        };
    }

    if (!command.source) {
        return {
            handled: true,
            response: 'ℹ️ 用法: /skill-install <来源>\n支持: owner/repo[/path]、GitHub URL、.skill/.zip 路径或 URL',
        };
    }

    const result = await installSkillFromSource({
        source: command.source,
        skillsDir: params.skillsDir,
    });
    await params.reloadAgent();
    return {
        handled: true,
        response: `${formatSkillInstallResult(result)}\n\n✅ 技能索引已热重载。`,
    };
}
