import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompactionConfig } from '../config.js';
import {
    buildMemoryFlushPrompt,
    createMemoryFlushState,
    getMemoryFlushRearmThreshold,
    getMemoryFlushTriggerThreshold,
    markFlushCompleted,
    setTotalTokens,
    shouldTriggerMemoryFlush,
} from './memory-flush.js';

function createCompactionConfig(overrides?: Partial<CompactionConfig>): CompactionConfig {
    return {
        enabled: true,
        auto_compact_threshold: 80_000,
        context_window: 128_000,
        reserve_tokens: 20_000,
        max_history_share: 0.5,
        ...overrides,
    };
}

test('memory flush triggers once per cycle and rearms below hysteresis threshold', () => {
    const config = createCompactionConfig();
    const flushThreshold = getMemoryFlushTriggerThreshold(config);
    const rearmThreshold = getMemoryFlushRearmThreshold(config);

    let state = createMemoryFlushState();
    state = setTotalTokens(state, flushThreshold, config);
    assert.equal(shouldTriggerMemoryFlush(state, config), true);

    state = markFlushCompleted(state);
    state = setTotalTokens(state, flushThreshold + 2_000, config);
    assert.equal(state.flushCycleArmed, false);
    assert.equal(shouldTriggerMemoryFlush(state, config), false);

    state = setTotalTokens(state, rearmThreshold - 1, config);
    assert.equal(state.flushCycleArmed, true);
    assert.equal(shouldTriggerMemoryFlush(state, config), false);
});

test('memory flush prompt requires the structured in-progress working summary schema', () => {
    const prompt = buildMemoryFlushPrompt();

    assert.match(prompt, /## 当前任务/);
    assert.match(prompt, /## 最新用户请求/);
    assert.match(prompt, /## 已完成进展/);
    assert.match(prompt, /## 进行中工作/);
    assert.match(prompt, /## 待办与后续承诺/);
    assert.match(prompt, /## 关键决策与约束/);
    assert.match(prompt, /## 未解决问题与风险/);
    assert.match(prompt, /不要再包一层“对话摘要:”前缀/);
    assert.match(prompt, /target: "daily"/);
    assert.match(prompt, /NO_REPLY/);
});
