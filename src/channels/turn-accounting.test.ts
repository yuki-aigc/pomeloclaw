import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFlushState } from '../middleware/index.js';
import type { CompactionConfig } from '../config.js';
import { applyTurnTokenAccounting } from './turn-accounting.js';

const compactionConfig: CompactionConfig = {
    enabled: true,
    auto_compact_threshold: 0.8,
    context_window: 10000,
    reserve_tokens: 500,
    max_history_share: 0.8,
};

test('applyTurnTokenAccounting returns updated flush state and positive token delta', async () => {
    const initialState = createMemoryFlushState();

    const result = await applyTurnTokenAccounting({
        flushState: initialState,
        text: '这是一次新的输入内容。',
        compactionConfig,
    });

    assert.ok(result.flushState.totalTokens > 0);
    assert.equal(result.tokenDelta, result.flushState.totalTokens);
});

test('applyTurnTokenAccounting accumulates token usage from previous state', async () => {
    const first = await applyTurnTokenAccounting({
        flushState: createMemoryFlushState(),
        text: '第一段内容',
        compactionConfig,
    });

    const second = await applyTurnTokenAccounting({
        flushState: first.flushState,
        text: '第二段内容',
        compactionConfig,
    });

    assert.ok(second.flushState.totalTokens > first.flushState.totalTokens);
    assert.equal(second.flushState.totalTokens, first.flushState.totalTokens + second.tokenDelta);
});
