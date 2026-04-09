import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    listSkillFiles,
    listSkillMarkdownFiles,
    readMemoryMarkdownFile,
    readSkillFile,
    readSkillMarkdownFile,
    writeSkillFile,
    writeMemoryMarkdownFile,
    writeSkillMarkdownFile,
} from './workspace-file-store.js';

test('skill markdown read/write/list works', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'srebot-web-skill-store-'));
    const skillsRoot = path.join(root, 'skills');
    const skillDir = path.join(skillsRoot, 'alert-rca');

    try {
        await mkdir(skillDir, { recursive: true });
        await writeFile(path.join(skillDir, 'SKILL.md'), '# Skill\n\nhello', 'utf8');

        const listed = await listSkillMarkdownFiles(skillsRoot);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.skillDir, 'alert-rca');

        const readResult = await readSkillMarkdownFile({
            skillsRoot,
            skillDir: 'alert-rca',
        });
        assert.equal(readResult.exists, true);
        assert.equal(readResult.content, '# Skill\n\nhello');

        const writeResult = await writeSkillMarkdownFile({
            skillsRoot,
            skillDir: 'alert-rca',
            content: '# Skill\n\nupdated',
        });
        assert.equal(writeResult.exists, true);
        assert.equal(writeResult.content, '# Skill\n\nupdated');

        const after = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
        assert.equal(after, '# Skill\n\nupdated');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('skill file tree + custom file read/write works', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'srebot-web-skill-store-'));
    const skillsRoot = path.join(root, 'skills');
    const skillDir = path.join(skillsRoot, 'cloud-resource-bill');

    try {
        await mkdir(path.join(skillDir, 'docs'), { recursive: true });
        await writeFile(path.join(skillDir, 'SKILL.md'), '# Skill', 'utf8');
        await writeFile(path.join(skillDir, 'docs', 'README.md'), '# Readme', 'utf8');
        await writeFile(path.join(skillDir, 'script.sh'), '#!/bin/bash\necho ok\n', 'utf8');

        const tree = await listSkillFiles({
            skillsRoot,
            skillDir: 'cloud-resource-bill',
        });
        assert.equal(tree.exists, true);
        assert.equal(tree.fileCount, 3);
        const docsNode = tree.tree.find((item) => item.path === 'docs');
        assert.ok(docsNode);
        assert.equal(docsNode.kind, 'directory');
        assert.ok(Array.isArray(docsNode.children));
        assert.ok(docsNode.children?.some((item) => item.path === 'docs/README.md' && item.kind === 'file'));
        assert.ok(tree.tree.some((item) => item.path === 'script.sh' && item.kind === 'file'));

        const readNested = await readSkillFile({
            skillsRoot,
            skillDir: 'cloud-resource-bill',
            relativePath: 'docs/README.md',
        });
        assert.equal(readNested.exists, true);
        assert.equal(readNested.content, '# Readme');

        const writeNested = await writeSkillFile({
            skillsRoot,
            skillDir: 'cloud-resource-bill',
            relativePath: 'scripts/fix.py',
            content: 'print("ok")\n',
        });
        assert.equal(writeNested.exists, true);
        assert.equal(writeNested.relativePath, 'scripts/fix.py');

        const content = await readFile(path.join(skillDir, 'scripts', 'fix.py'), 'utf8');
        assert.equal(content, 'print("ok")\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('skill markdown rejects illegal skill dir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'srebot-web-skill-store-'));
    const skillsRoot = path.join(root, 'skills');

    try {
        await assert.rejects(
            () => readSkillMarkdownFile({
                skillsRoot,
                skillDir: '../escape',
            }),
            /skill 非法/u,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('skill file rejects unsafe relative path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'srebot-web-skill-store-'));
    const skillsRoot = path.join(root, 'skills');
    try {
        await assert.rejects(
            () => readSkillFile({
                skillsRoot,
                skillDir: 'alert-rca',
                relativePath: '../secret.txt',
            }),
            /路径非法/u,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('memory markdown read/write supports scoped MEMORY.md and scoped daily path', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'srebot-web-memory-store-'));

    try {
        const first = await readMemoryMarkdownFile({ workspaceRoot });
        assert.equal(first.exists, false);
        assert.equal(first.relativePath, 'memory/scopes/main/MEMORY.md');

        const writeDefault = await writeMemoryMarkdownFile({
            workspaceRoot,
            content: '# MEMORY\n\nabc',
        });
        assert.equal(writeDefault.exists, true);
        assert.equal(writeDefault.relativePath, 'memory/scopes/main/MEMORY.md');

        const writeDaily = await writeMemoryMarkdownFile({
            workspaceRoot,
            relativePath: 'memory/scopes/main/2026-03-11.md',
            content: '# Daily\n\nnote',
        });
        assert.equal(writeDaily.exists, true);
        assert.equal(writeDaily.relativePath, 'memory/scopes/main/2026-03-11.md');

        const readDaily = await readMemoryMarkdownFile({
            workspaceRoot,
            relativePath: 'memory/scopes/main/2026-03-11.md',
        });
        assert.equal(readDaily.exists, true);
        assert.equal(readDaily.content, '# Daily\n\nnote');
    } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('memory markdown rejects unsafe relative paths', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'srebot-web-memory-store-'));
    try {
        await assert.rejects(
            () => writeMemoryMarkdownFile({
                workspaceRoot,
                relativePath: '../../etc/passwd',
                content: 'x',
            }),
            /路径非法/u,
        );
        await assert.rejects(
            () => writeMemoryMarkdownFile({
                workspaceRoot,
                relativePath: 'memory/not-markdown.txt',
                content: 'x',
            }),
            /memory 路径非法/u,
        );
    } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('memory markdown rejects symlink targets', async () => {
    if (process.platform === 'win32') {
        return;
    }

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'srebot-web-memory-store-'));
    try {
        const memoryDir = path.join(workspaceRoot, 'memory');
        await mkdir(memoryDir, { recursive: true });
        await symlink('/tmp', path.join(memoryDir, 'link.md'));

        await assert.rejects(
            () => readMemoryMarkdownFile({
                workspaceRoot,
                relativePath: 'memory/link.md',
            }),
            /路径非法/u,
        );
    } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
    }
});
