import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPromptBootstrapMessage } from './bootstrap.js';

test('bootstrap keeps scoped MEMORY content visible under total budget pressure', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'srebot-bootstrap-'));
    const scopeKey = 'direct_web_user_x';
    const memoryDir = join(tempDir, 'memory', 'scopes', scopeKey);
    const sentinel = '[[MEMORY_SENTINEL_SHOULD_SURVIVE]]';

    try {
        await mkdir(memoryDir, { recursive: true });
        await writeFile(join(tempDir, 'AGENTS.md'), '# AGENTS\n\n' + 'A'.repeat(20_000), 'utf-8');
        await writeFile(join(tempDir, 'TOOLS.md'), '# TOOLS\n\n' + 'T'.repeat(12_000), 'utf-8');
        await writeFile(join(tempDir, 'SOUL.md'), '# SOUL\n\n' + 'S'.repeat(12_000), 'utf-8');
        await writeFile(join(tempDir, 'HEARTBEAT.md'), '# HEARTBEAT\n\n' + 'H'.repeat(12_000), 'utf-8');
        await writeFile(
            join(memoryDir, 'MEMORY.md'),
            '# MEMORY\n\n' + 'M'.repeat(1750) + sentinel + '\n' + 'M'.repeat(4000),
            'utf-8',
        );

        const message = await buildPromptBootstrapMessage({
            workspacePath: tempDir,
            scopeKey,
        });

        assert.ok(message);
        const content = message?.content || '';
        assert.match(content, /## MEMORY/);
        assert.match(content, new RegExp(sentinel));
        assert.ok(content.length <= 12_000, `bootstrap content too long: ${content.length}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
