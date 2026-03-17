import test from 'node:test';
import assert from 'node:assert/strict';
import {
    consumeAgentStreamEvents,
    executeMemoryFlushCore,
    pickFinalStreamResponse,
    pickInvokeResponse,
} from './agent-execution.js';
import { createMemoryFlushState, setTotalTokens } from '../middleware/index.js';
import type { RuntimeAgent, RuntimeAgentInvokeResult, RuntimeAgentStreamEvent } from '../agent.js';
import type { CompactionConfig } from '../config.js';

async function* createEventStream(events: RuntimeAgentStreamEvent[]): AsyncIterable<RuntimeAgentStreamEvent> {
    for (const event of events) {
        yield event;
    }
}

const compactionConfig: CompactionConfig = {
    enabled: true,
    context_window: 10000,
    auto_compact_threshold: 0.8,
    reserve_tokens: 500,
    max_history_share: 0.8,
};

test('consumeAgentStreamEvents tracks visible text and final output', async () => {
    const state = await consumeAgentStreamEvents({
        eventStream: createEventStream([
            {
                event: 'on_chat_model_stream',
                data: {
                    chunk: {
                        content: '开始分析',
                    },
                },
            },
            {
                event: 'on_tool_start',
                name: 'memory_search',
            },
            {
                event: 'on_chat_model_stream',
                data: {
                    chunk: {
                        content: '，结论如下',
                    },
                },
            },
            {
                event: 'on_chain_end',
                data: {
                    output: {
                        messages: [
                            { role: 'assistant', content: '最终回答' },
                        ],
                    },
                },
            },
        ]),
        sanitizeText: (text) => text.trim(),
    });

    assert.equal(state.rawStreamResponse, '开始分析，结论如下');
    assert.equal(state.visibleResponse, '开始分析，结论如下');
    assert.equal(state.finalOutputFromEvents, '最终回答');
    assert.equal(state.sawToolCall, true);
    assert.equal(pickFinalStreamResponse(state), '最终回答');
});

test('consumeAgentStreamEvents can suppress visible tool payloads while preserving final answer', async () => {
    const state = await consumeAgentStreamEvents({
        eventStream: createEventStream([
            {
                event: 'on_tool_start',
                name: 'weather',
            },
            {
                event: 'on_chat_model_stream',
                data: {
                    chunk: {
                        content: '{"temperature":18}',
                    },
                },
            },
            {
                event: 'on_chain_end',
                data: {
                    output: {
                        messages: [
                            { role: 'assistant', content: '杭州今天 18 度。' },
                        ],
                    },
                },
            },
        ]),
        sanitizeText: (text) => text.trim(),
        shouldAcceptVisibleText: () => false,
    });

    assert.equal(state.visibleResponse, '');
    assert.equal(pickFinalStreamResponse(state), '杭州今天 18 度。');
});

test('pickInvokeResponse prefers assistant-readable output', () => {
    const result: RuntimeAgentInvokeResult = {
        messages: [
            { content: '{"ok":true}' },
            { role: 'assistant', content: '这是最终回复' } as unknown as { content?: unknown },
        ],
    };

    assert.equal(pickInvokeResponse(result), '这是最终回复');
});

test('executeMemoryFlushCore preserves token count when requested', async () => {
    let state = createMemoryFlushState();
    state = setTotalTokens(state, 3200, compactionConfig);

    const agent: RuntimeAgent = {
        invoke: async () => ({
            messages: [{ content: 'NO_REPLY' }],
        }),
        streamEvents: async function* () {
            return;
        },
    };

    const result = await executeMemoryFlushCore({
        agent,
        threadId: 'thread-1',
        recursionLimit: 10,
        flushState: state,
        compactionConfig,
        preserveTokenCount: true,
    });

    assert.equal(result.noReply, true);
    assert.equal(result.nextState.totalTokens, 3200);
    assert.equal(result.nextState.flushCount, 1);
});
