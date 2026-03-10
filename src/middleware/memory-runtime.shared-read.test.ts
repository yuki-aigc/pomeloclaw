import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { MemoryRuntime } from './memory-runtime.js';
import type { MemoryScope } from './memory-scope.js';

async function createTestRuntime(sharedMainScopeReads: boolean): Promise<{
    runtime: MemoryRuntime;
    workspacePath: string;
    scope: MemoryScope;
}> {
    const workspacePath = await mkdtemp(join(tmpdir(), 'pomelobot-memory-'));
    const config = structuredClone(DEFAULT_CONFIG);
    config.agent.memory.backend = 'filesystem';
    config.agent.memory.pgsql.enabled = false;
    config.agent.memory.session_isolation.shared_main_scope_reads = sharedMainScopeReads;

    await mkdir(join(workspacePath, 'memory', 'scopes', 'group_demo'), { recursive: true });
    await writeFile(
        join(workspacePath, 'MEMORY.md'),
        '# Long-term Memory (main)\n\n[10:00:00] 团队共享排障经验：先确认当前日期再查询数据。\n',
        'utf-8',
    );
    await writeFile(
        join(workspacePath, 'memory', 'scopes', 'group_demo', 'LONG_TERM.md'),
        '# Long-term Memory (group_demo)\n\n[10:05:00] 本群的本地上下文。\n',
        'utf-8',
    );

    const runtime = await MemoryRuntime.create(workspacePath, config);
    const scope: MemoryScope = {
        key: 'group_demo',
        kind: 'group',
    };
    return { runtime, workspacePath, scope };
}

test('isolated scopes can search main shared memory when enabled', async (t) => {
    const { runtime, workspacePath, scope } = await createTestRuntime(true);
    t.after(async () => {
        await runtime.close();
        await rm(workspacePath, { recursive: true, force: true });
    });

    const hits = await runtime.search('团队共享排障经验', scope);
    assert.ok(hits.some((hit) => hit.path === 'MEMORY.md'));

    const result = await runtime.get('MEMORY.md', { from: 1, lines: 20 }, scope);
    assert.equal(result.path, 'MEMORY.md');
    assert.match(result.text, /先确认当前日期再查询数据/);
});

test('isolated scopes still block main shared memory reads when disabled', async (t) => {
    const { runtime, workspacePath, scope } = await createTestRuntime(false);
    t.after(async () => {
        await runtime.close();
        await rm(workspacePath, { recursive: true, force: true });
    });

    const hits = await runtime.search('团队共享排障经验', scope);
    assert.equal(hits.some((hit) => hit.path === 'MEMORY.md'), false);

    await assert.rejects(
        () => runtime.get('MEMORY.md', { from: 1, lines: 20 }, scope),
        /memory_get path is not allowed/,
    );
});
