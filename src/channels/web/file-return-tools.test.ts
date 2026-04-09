import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebFileReturnTools } from './file-return-tools.js';
import { withWebConversationContext, consumeQueuedWebReplyFiles } from './context.js';

const silentLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

test('web_write_tmp_file writes file into workspace tmp and queues attachment', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'srebot-web-tools-'));
    const [writeTool] = createWebFileReturnTools(workspaceRoot, silentLogger);

    try {
        await withWebConversationContext(
            {
                conversationId: 'conv-1',
                isDirect: true,
                senderId: 'user-1',
                senderName: 'User One',
                workspaceRoot,
            },
            async () => {
                const result = await (writeTool as { invoke: (input: { fileName: string; content: string }) => Promise<unknown> }).invoke({
                    fileName: 'report.md',
                    content: '# hello',
                });

                assert.match(String(result), /已写入并登记回传/);
                const queued = consumeQueuedWebReplyFiles();
                assert.equal(queued.length, 1);
                assert.equal(path.basename(queued[0]), 'report.md');
                const content = await readFile(queued[0], 'utf8');
                assert.equal(content, '# hello');
            },
        );
    } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
    }
});
