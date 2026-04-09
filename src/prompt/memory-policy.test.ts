import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    buildSessionStartupMemoryInjection,
    buildUserMessagesWithMemoryPolicy,
    hasMemoryRecallIntent,
} from './memory-policy.js';

function formatLocalDateWithOffset(baseDate: Date, offsetDays: number): string {
    const date = new Date(baseDate.getTime() + (offsetDays * 24 * 60 * 60 * 1000));
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

test('hasMemoryRecallIntent detects recall-like user text', () => {
    assert.equal(hasMemoryRecallIntent('你还记得我们上次聊过什么吗？'), true);
    assert.equal(hasMemoryRecallIntent('帮我总结这段代码'), false);
});

test('buildUserMessagesWithMemoryPolicy enforces memory_search when recall intent is on', () => {
    const messages = buildUserMessagesWithMemoryPolicy('昨天你答应了什么？', {
        enforceMemorySearch: true,
        startupMemoryInjection: null,
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0]?.content || '', /你必须先调用 memory_search/);
    assert.match(messages[0]?.content || '', /用户原问题：昨天你答应了什么？/);
});

test('buildSessionStartupMemoryInjection reads today and yesterday scoped daily files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'srebot-memory-policy-'));
    const scopeKey = 'direct_web_user1';
    const now = new Date('2026-03-12T12:00:00.000Z');
    const today = formatLocalDateWithOffset(now, 0);
    const yesterday = formatLocalDateWithOffset(now, -1);
    const scopeDir = join(tempDir, 'memory', 'scopes', scopeKey);

    try {
        await mkdir(scopeDir, { recursive: true });
        await writeFile(
            join(scopeDir, `${today}.md`),
            `# Daily Memory - ${today}\n\n[10:00:00] today note`,
            'utf-8',
        );
        await writeFile(
            join(scopeDir, `${yesterday}.md`),
            `# Daily Memory - ${yesterday}\n\n[09:00:00] yesterday note`,
            'utf-8',
        );

        const injected = await buildSessionStartupMemoryInjection({
            workspacePath: tempDir,
            scopeKey,
            now,
        });

        assert.ok(injected);
        assert.match(injected || '', new RegExp(`memory/scopes/${scopeKey}/${today}\\.md`));
        assert.match(injected || '', new RegExp(`memory/scopes/${scopeKey}/${yesterday}\\.md`));
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
