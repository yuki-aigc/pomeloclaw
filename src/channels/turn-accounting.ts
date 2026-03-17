import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CompactionConfig } from '../config.js';
import {
    updateTokenCountWithModel,
    type MemoryFlushState,
} from '../middleware/index.js';

export interface TurnTokenAccountingResult {
    flushState: MemoryFlushState;
    tokenDelta: number;
}

export async function applyTurnTokenAccounting(params: {
    flushState: MemoryFlushState;
    text: string;
    model?: BaseChatModel;
    compactionConfig: CompactionConfig;
}): Promise<TurnTokenAccountingResult> {
    const previousTotalTokens = params.flushState.totalTokens;
    const flushState = await updateTokenCountWithModel(
        params.flushState,
        params.text,
        params.model,
        params.compactionConfig,
    );

    return {
        flushState,
        tokenDelta: Math.max(0, flushState.totalTokens - previousTotalTokens),
    };
}
