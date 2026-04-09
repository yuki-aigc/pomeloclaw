import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    enqueueConversationTask,
    prepareConversationUserMessages,
    withTimeout,
} from './conversation-utils.js';

function formatLocalDateWithOffset(baseDate: Date, offsetDays: number): string {
    const date = new Date(baseDate.getTime() + (offsetDays * 24 * 60 * 60 * 1000));
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

test('prepareConversationUserMessages injects startup memory and recall policy together', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'srebot-conversation-utils-'));
    const scopeKey = 'group_demo';
    const now = new Date();
    const today = formatLocalDateWithOffset(now, 0);
    const scopeDir = join(tempDir, 'memory', 'scopes', scopeKey);

    try {
        await mkdir(scopeDir, { recursive: true });
        await writeFile(
            join(scopeDir, `${today}.md`),
            '# Daily Memory\n\n今天讨论过数据库回滚窗口和发布计划。',
            'utf-8',
        );

        const prepared = await prepareConversationUserMessages({
            userText: '你还记得我们今天讨论过什么吗？',
            workspacePath: tempDir,
            scopeKey,
            includeStartupMemory: true,
        });

        assert.equal(prepared.enforceMemorySearch, true);
        assert.ok(prepared.startupMemoryInjection);
        assert.equal(prepared.userMessages.length, 2);
        assert.match(prepared.userMessages[0]?.content || '', /会话启动记忆注入/);
        assert.match(prepared.userMessages[1]?.content || '', /你必须先调用 memory_search/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('enqueueConversationTask runs tasks serially for the same conversation', async () => {
    const queue = new Map<string, Promise<void>>();
    const order: string[] = [];

    await Promise.all([
        enqueueConversationTask(queue, 'conv-1', async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push('first');
        }),
        enqueueConversationTask(queue, 'conv-1', async () => {
            order.push('second');
        }),
    ]);

    assert.deepEqual(order, ['first', 'second']);
    assert.equal(queue.size, 0);
});

test('withTimeout rejects when the wrapped promise exceeds the limit', async () => {
    await assert.rejects(
        withTimeout(
            new Promise((resolve) => setTimeout(resolve, 30)),
            5,
            'timed out',
        ),
        /timed out/,
    );
});
