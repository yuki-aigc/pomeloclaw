import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSelectedSkillsInstruction,
    collectRequestedWebSkills,
    resolveRequestedWebSkills,
} from './skill-selection.js';

test('collectRequestedWebSkills normalizes aliases and removes duplicates', () => {
    const requested = collectRequestedWebSkills({
        skills: ['@Audit', 'audit', ' skill-creator '],
        skillNames: ['audit'],
    });

    assert.deepEqual(requested, ['audit', 'skill-creator']);
});

test('resolveRequestedWebSkills matches by skill name and dir name', () => {
    const resolved = resolveRequestedWebSkills(
        ['audit', 'custom-skill-dir', 'missing-skill'],
        [
            {
                name: 'audit',
                description: 'audit description',
                dirName: 'audit',
                absPath: '/tmp/audit',
                updatedAtMs: 1,
            },
            {
                name: 'skill-creator',
                description: 'skill creator description',
                dirName: 'custom-skill-dir',
                absPath: '/tmp/skill-creator',
                updatedAtMs: 2,
            },
        ],
    );

    assert.deepEqual(resolved.selected, ['audit', 'skill-creator']);
    assert.deepEqual(resolved.unknown, ['missing-skill']);
});

test('buildSelectedSkillsInstruction includes selected skill names', () => {
    const prompt = buildSelectedSkillsInstruction(['audit', 'skill-creator']);

    assert.match(prompt, /\[技能选择\]/);
    assert.match(prompt, /audit/);
    assert.match(prompt, /skill-creator/);
});
