import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { buildAttachmentMediaContext } from './media-context.js';

test('buildAttachmentMediaContext reads text files into file blocks', async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'srebot-media-'));
    const filePath = path.join(tempDir, 'notes.md');
    await fsPromises.writeFile(filePath, '# Title\nhello from attachment\n');

    try {
        const mediaContext = await buildAttachmentMediaContext({
            config: {} as never,
            attachments: [
                {
                    name: 'notes.md',
                    path: filePath,
                    mimeType: 'text/markdown; charset=utf-8',
                    metadata: { mediaType: 'file' },
                },
            ],
            log: {
                warn: () => undefined,
                debug: () => undefined,
            },
        });

        assert.ok(mediaContext);
        assert.match(mediaContext || '', /\[媒体上下文\]/);
        assert.match(mediaContext || '', /<file name="notes\.md" mime="text\/markdown; charset=utf-8"/);
        assert.match(mediaContext || '', /hello from attachment/);
    } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
});
