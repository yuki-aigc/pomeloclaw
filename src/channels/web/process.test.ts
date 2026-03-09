import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendProcessCommentaryBlock,
    buildProcessPayload,
    buildProcessSummary,
    extractProcessPreview,
} from './process.js';

test('appendProcessCommentaryBlock merges adjacent commentary blocks', () => {
    const blocks: Array<{ type: 'commentary'; text: string }> = [];
    appendProcessCommentaryBlock(blocks, '先读取 skill。');
    appendProcessCommentaryBlock(blocks, ' 再执行脚本。');

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.text, '先读取 skill。 再执行脚本。');
});

test('extractProcessPreview prefers readable nested output', () => {
    const preview = extractProcessPreview({
        output: {
            messages: [
                { role: 'assistant', content: [{ text: '分析脚本执行完成' }] },
            ],
        },
    });

    assert.equal(preview, '分析脚本执行完成');
});

test('buildProcessSummary lists tools and commentary counts', () => {
    const summary = buildProcessSummary([
        { type: 'commentary', text: '先读取 skill' },
        { type: 'tool', phase: 'start', toolName: 'read_skill' },
        { type: 'tool', phase: 'end', toolName: 'read_skill' },
        { type: 'tool', phase: 'start', toolName: 'exec_command' },
    ]);

    assert.match(summary, /过程文本/);
    assert.match(summary, /read_skill/);
    assert.match(summary, /exec_command/);
});

test('buildProcessPayload returns undefined for empty blocks', () => {
    assert.equal(buildProcessPayload([]), undefined);
});
