import test from 'node:test';
import assert from 'node:assert/strict';
import { setTotalTokens } from '../../middleware/index.js';
import { buildWebTokenUsagePayload, createEmptyWebTokenUsageSource } from './token-usage.js';
import type { CompactionConfig } from '../../config.js';

const compactionConfig: CompactionConfig = {
    enabled: true,
    auto_compact_threshold: 80000,
    context_window: 128000,
    reserve_tokens: 20000,
    max_history_share: 0.5,
};

test('buildWebTokenUsagePayload exposes raw counts and percentages', () => {
    const source = createEmptyWebTokenUsageSource(1710000000000);
    source.flushState = setTotalTokens(source.flushState, 115000, compactionConfig);
    source.totalInputTokens = 4200;
    source.totalOutputTokens = 1800;

    const payload = buildWebTokenUsagePayload(source, compactionConfig);

    assert.equal(payload.inputTokens, 4200);
    assert.equal(payload.outputTokens, 1800);
    assert.equal(payload.contextTokens, 115000);
    assert.equal(payload.contextWindow, 128000);
    assert.equal(payload.contextUsagePercent, 90);
    assert.equal(payload.contextRemainingTokens, 13000);
    assert.equal(payload.updatedAt, 1710000000000);
    assert.equal(payload.formatted.contextTokens, '115.0K');
});

test('buildWebTokenUsagePayload respects hard budget and auto compact threshold', () => {
    const payload = buildWebTokenUsagePayload(createEmptyWebTokenUsageSource(), compactionConfig);

    assert.equal(payload.hardContextBudget, 108000);
    assert.equal(payload.autoCompactThreshold, 80000);
    assert.equal(payload.hardContextRemainingTokens, 108000);
    assert.equal(payload.autoCompactRemainingTokens, 80000);
    assert.equal(payload.contextRemainingPercent, 100);
});
