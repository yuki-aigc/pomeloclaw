import {
    formatTokenCount,
    getCompactionHardContextBudget,
    getEffectiveAutoCompactThreshold,
    type CompactionConfig,
} from '../../compaction/index.js';
import { createMemoryFlushState, type MemoryFlushState } from '../../middleware/index.js';
import type { WebTokenUsagePayload } from './types.js';

export interface WebTokenUsageSource {
    flushState: MemoryFlushState;
    totalInputTokens: number;
    totalOutputTokens: number;
    lastUpdatedAt: number;
}

export function createEmptyWebTokenUsageSource(now: number = Date.now()): WebTokenUsageSource {
    return {
        flushState: createMemoryFlushState(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastUpdatedAt: now,
    };
}

export function buildWebTokenUsagePayload(
    source: WebTokenUsageSource,
    compactionConfig: CompactionConfig,
): WebTokenUsagePayload {
    const contextTokens = Math.max(0, Math.floor(source.flushState.totalTokens));
    const contextWindow = Math.max(1, Math.floor(compactionConfig.context_window));
    const contextUsagePercent = Math.max(0, Math.min(100, Math.round((contextTokens / contextWindow) * 100)));
    const contextRemainingTokens = Math.max(0, contextWindow - contextTokens);
    const contextRemainingPercent = Math.max(0, 100 - contextUsagePercent);
    const hardContextBudget = Math.max(1, getCompactionHardContextBudget(compactionConfig));
    const hardContextRemainingTokens = Math.max(0, hardContextBudget - contextTokens);
    const autoCompactThreshold = Math.max(1, getEffectiveAutoCompactThreshold(compactionConfig));
    const autoCompactRemainingTokens = Math.max(0, autoCompactThreshold - contextTokens);

    return {
        inputTokens: Math.max(0, Math.floor(source.totalInputTokens)),
        outputTokens: Math.max(0, Math.floor(source.totalOutputTokens)),
        contextTokens,
        contextWindow,
        contextUsagePercent,
        contextRemainingTokens,
        contextRemainingPercent,
        hardContextBudget,
        hardContextRemainingTokens,
        autoCompactThreshold,
        autoCompactRemainingTokens,
        flushCount: Math.max(0, Math.floor(source.flushState.flushCount)),
        flushCycleArmed: Boolean(source.flushState.flushCycleArmed),
        updatedAt: source.lastUpdatedAt,
        formatted: {
            inputTokens: formatTokenCount(Math.max(0, Math.floor(source.totalInputTokens))),
            outputTokens: formatTokenCount(Math.max(0, Math.floor(source.totalOutputTokens))),
            contextTokens: formatTokenCount(contextTokens),
            contextWindow: formatTokenCount(contextWindow),
            contextRemainingTokens: formatTokenCount(contextRemainingTokens),
            hardContextBudget: formatTokenCount(hardContextBudget),
            autoCompactThreshold: formatTokenCount(autoCompactThreshold),
        },
    };
}
