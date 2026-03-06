import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeSkillSlashCommand, parseSkillSlashCommand } from './slash.js';

async function createSkillDir(rootDir: string): Promise<void> {
    const skillDir = path.join(rootDir, 'demo-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: demo-skill\ndescription: slash command test\n---\n\n# Demo\n',
        'utf-8',
    );
}

test('parseSkillSlashCommand recognizes skill commands', () => {
    assert.deepEqual(parseSkillSlashCommand('/skills'), { type: 'list' });
    assert.deepEqual(parseSkillSlashCommand('/skill-reload'), { type: 'reload' });
    assert.deepEqual(parseSkillSlashCommand('/skill-remove demo-skill'), { type: 'remove', skillName: 'demo-skill' });
    assert.deepEqual(parseSkillSlashCommand('/skill-install owner/repo'), { type: 'install', source: 'owner/repo' });
    assert.equal(parseSkillSlashCommand('/status'), null);
});

test('executeSkillSlashCommand lists installed skills and triggers reload', async () => {
    const skillsDir = await mkdtemp(path.join(os.tmpdir(), 'pomelobot-skill-slash-'));
    let reloadCount = 0;
    try {
        await createSkillDir(skillsDir);

        const listResult = await executeSkillSlashCommand({
            input: '/skills',
            skillsDir,
            reloadAgent: async () => {
                reloadCount += 1;
            },
        });
        assert.equal(listResult.handled, true);
        assert.match(listResult.response || '', /demo-skill/);
        assert.equal(reloadCount, 0);

        const reloadResult = await executeSkillSlashCommand({
            input: '/skill-reload',
            skillsDir,
            reloadAgent: async () => {
                reloadCount += 1;
            },
        });
        assert.equal(reloadResult.handled, true);
        assert.match(reloadResult.response || '', /重新加载/);
        assert.equal(reloadCount, 1);
    } finally {
        await rm(skillsDir, { recursive: true, force: true });
    }
});

test('executeSkillSlashCommand removes installed skills and triggers reload', async () => {
    const skillsDir = await mkdtemp(path.join(os.tmpdir(), 'pomelobot-skill-remove-slash-'));
    let reloadCount = 0;
    try {
        await createSkillDir(skillsDir);

        const result = await executeSkillSlashCommand({
            input: '/skill-remove demo-skill',
            skillsDir,
            reloadAgent: async () => {
                reloadCount += 1;
            },
        });

        assert.equal(result.handled, true);
        assert.match(result.response || '', /技能已删除/);
        assert.equal(reloadCount, 1);
    } finally {
        await rm(skillsDir, { recursive: true, force: true });
    }
});
