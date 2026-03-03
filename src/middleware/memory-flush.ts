import type { CompactionConfig } from '../config.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { countTokensWithModel, getEffectiveAutoCompactThreshold } from '../compaction/index.js';
import { WORKING_SUMMARY_REQUIREMENTS, WORKING_SUMMARY_SCHEMA } from '../compaction/summary-schema.js';

const MEMORY_FLUSH_TRIGGER_RATIO = 0.9;
const MEMORY_FLUSH_HYSTERESIS_RATIO = 0.85;

/**
 * Estimate token count for a text string
 * Uses a simple heuristic: ~1 token per Chinese character, ~1 token per 4 English characters
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;

    // Count Chinese characters (each is roughly 1 token)
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;

    // Count English words (each word is roughly 1.3 tokens on average)
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;

    // Count numbers and special characters
    const otherChars = text.replace(/[\u4e00-\u9fa5a-zA-Z\s]/g, '').length;

    return Math.ceil(chineseChars + englishWords * 1.3 + otherChars * 0.5);
}

/**
 * Memory flush state tracker
 */
export interface MemoryFlushState {
    totalTokens: number;
    lastFlushTokens: number;  // Token count at last flush
    lastFlushAt: number;
    flushCount: number;
    flushCycleArmed: boolean;
    conversationSummary: string[];  // Track key points from conversation
}

/**
 * Create a new memory flush state
 */
export function createMemoryFlushState(): MemoryFlushState {
    return {
        totalTokens: 0,
        lastFlushTokens: 0,
        lastFlushAt: 0,
        flushCount: 0,
        flushCycleArmed: true,
        conversationSummary: [],
    };
}

export function getMemoryFlushTriggerThreshold(config: CompactionConfig): number {
    const autoCompactThreshold = getEffectiveAutoCompactThreshold(config);
    return Math.max(1, Math.floor(autoCompactThreshold * MEMORY_FLUSH_TRIGGER_RATIO));
}

export function getMemoryFlushRearmThreshold(config: CompactionConfig): number {
    const triggerThreshold = getMemoryFlushTriggerThreshold(config);
    return Math.max(1, Math.floor(triggerThreshold * MEMORY_FLUSH_HYSTERESIS_RATIO));
}

function maybeRearmFlushCycle(state: MemoryFlushState, config: CompactionConfig): MemoryFlushState {
    if (state.flushCycleArmed) {
        return state;
    }
    const rearmThreshold = getMemoryFlushRearmThreshold(config);
    if (state.totalTokens > rearmThreshold) {
        return state;
    }
    return {
        ...state,
        flushCycleArmed: true,
    };
}

/**
 * Check if memory flush should be triggered (before compaction)
 */
export function shouldTriggerMemoryFlush(
    state: MemoryFlushState,
    config: CompactionConfig
): boolean {
    if (!config.enabled) return false;
    if (!state.flushCycleArmed) {
        return false;
    }
    const flushThreshold = getMemoryFlushTriggerThreshold(config);
    return state.totalTokens >= flushThreshold;
}

export const MEMORY_FLUSH_SYSTEM_PROMPT = `
[系统提示] 会话上下文即将压缩。你必须执行以下操作：

1. 立即使用 memory_save 工具保存本次对话的关键信息
2. 必须保存的内容包括：
   - 当前任务、最新用户请求、已完成进展、进行中工作
   - 待办与后续承诺、关键决策与约束、未解决问题与风险
   - 用户表达的偏好、重要事实、命令、路径、日期、阈值、ID 等细节
3. 保存完成后回复 "NO_REPLY"

重要：你必须调用 memory_save 工具，不能只回复 NO_REPLY！
`;

export const MEMORY_FLUSH_USER_PROMPT = `
[自动记忆保存 - 强制执行]

请立即执行以下步骤：

STEP 1: 回顾当前对话，生成一份“进行中工作态摘要”。
STEP 2: 摘要必须使用以下固定结构；没有信息时写“无”：
${WORKING_SUMMARY_SCHEMA}

STEP 3: 摘要必须满足以下要求：
${WORKING_SUMMARY_REQUIREMENTS.map((item) => `- ${item}`).join('\n')}

STEP 4: 调用 memory_save 工具，将该结构化摘要保存到 daily 记忆：
   - content: 直接填写上面的结构化摘要正文，不要再包一层“对话摘要:”前缀
   - target: "daily"
STEP 5: 只有在 STEP 4 完成后，才回复 "NO_REPLY"

如果你不调用 memory_save 就直接回复 NO_REPLY，这是错误的行为！
`;

/**
 * Build a flush prompt safe for threaded conversations.
 * Some model providers reject non-leading system messages when thread history exists.
 */
export function buildMemoryFlushPrompt(): string {
    return [
        '[系统级要求 - 严格执行]',
        MEMORY_FLUSH_SYSTEM_PROMPT.trim(),
        '',
        MEMORY_FLUSH_USER_PROMPT.trim(),
    ].join('\n');
}

/**
 * Update token count in state
 */
export function updateTokenCount(
    state: MemoryFlushState,
    text: string,
    config?: CompactionConfig,
): MemoryFlushState {
    const newTokens = estimateTokens(text);
    const nextState = {
        ...state,
        totalTokens: state.totalTokens + newTokens,
    };
    if (!config) {
        return nextState;
    }
    return maybeRearmFlushCycle(nextState, config);
}

export async function updateTokenCountWithModel(
    state: MemoryFlushState,
    text: string,
    model?: BaseChatModel,
    config?: CompactionConfig,
): Promise<MemoryFlushState> {
    const newTokens = await countTokensWithModel(text, model);
    const nextState = {
        ...state,
        totalTokens: state.totalTokens + newTokens,
    };
    if (!config) {
        return nextState;
    }
    return maybeRearmFlushCycle(nextState, config);
}

export function setTotalTokens(
    state: MemoryFlushState,
    totalTokens: number,
    config: CompactionConfig,
): MemoryFlushState {
    const nextState = {
        ...state,
        totalTokens: Math.max(0, Math.floor(totalTokens)),
    };
    return maybeRearmFlushCycle(nextState, config);
}

/**
 * Mark flush as completed and RESET token count (simulating compaction)
 */
export function markFlushCompleted(state: MemoryFlushState): MemoryFlushState {
    return {
        ...state,
        totalTokens: 0,  // Reset after flush (compaction simulation)
        lastFlushTokens: state.totalTokens,
        lastFlushAt: Date.now(),
        flushCount: state.flushCount + 1,
        flushCycleArmed: false,
        conversationSummary: [],  // Clear summary after flush
    };
}

/**
 * Check if response is a NO_REPLY (should be suppressed)
 */
export function isNoReplyResponse(response: string): boolean {
    const trimmed = response.trim().toUpperCase();
    return trimmed === 'NO_REPLY' || trimmed.startsWith('NO_REPLY');
}

/**
 * Get current token usage info for debugging
 */
export function getTokenUsageInfo(state: MemoryFlushState, config: CompactionConfig): string {
    const percentage = Math.round((state.totalTokens / config.context_window) * 100);
    const flushThreshold = getMemoryFlushTriggerThreshold(config);
    const rearmThreshold = getMemoryFlushRearmThreshold(config);
    return `[Token 使用: ${formatTokens(state.totalTokens)}/${formatTokens(config.context_window)} (${percentage}%), flush 次数: ${state.flushCount}, flush armed: ${state.flushCycleArmed ? 'yes' : 'no'}, flush 阈值: ${formatTokens(flushThreshold)}, rearm 阈值: ${formatTokens(rearmThreshold)}]`;
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return `${tokens}`;
}
