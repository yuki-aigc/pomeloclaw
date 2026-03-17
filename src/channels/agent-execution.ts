import type { RuntimeAgent, RuntimeAgentInvokeResult, RuntimeAgentStreamEvent } from '../agent.js';
import type { CompactionConfig } from '../config.js';
import {
    buildMemoryFlushPrompt,
    isNoReplyResponse,
    markFlushCompleted,
    setTotalTokens,
    type MemoryFlushState,
} from '../middleware/index.js';
import {
    extractBestReadableReplyFromMessages,
    extractReplyTextFromEventData,
    extractStreamChunkText,
    pickBestUserFacingResponse,
} from './streaming.js';

export interface AgentStreamState {
    rawStreamResponse: string;
    visibleResponse: string;
    finalOutputFromEvents: string;
    lastToolOutputFromEvents: string;
    sawToolCall: boolean;
    eventCount: number;
}

export interface ConsumeAgentStreamEventsOptions {
    eventStream: AsyncIterable<RuntimeAgentStreamEvent>;
    sanitizeText: (text: string) => string;
    shouldAcceptVisibleText?: (candidate: string, state: AgentStreamState) => boolean;
    onEvent?: (event: RuntimeAgentStreamEvent, state: AgentStreamState) => Promise<void> | void;
    onVisibleResponseUpdated?: (params: {
        state: AgentStreamState;
        candidate: string;
        previousVisibleResponse: string;
        delta: string;
    }) => Promise<void> | void;
    onToolStart?: (event: RuntimeAgentStreamEvent, state: AgentStreamState) => Promise<void> | void;
    onToolEnd?: (event: RuntimeAgentStreamEvent, state: AgentStreamState) => Promise<void> | void;
}

export async function consumeAgentStreamEvents(
    options: ConsumeAgentStreamEventsOptions,
): Promise<AgentStreamState> {
    const state: AgentStreamState = {
        rawStreamResponse: '',
        visibleResponse: '',
        finalOutputFromEvents: '',
        lastToolOutputFromEvents: '',
        sawToolCall: false,
        eventCount: 0,
    };

    for await (const event of options.eventStream) {
        state.eventCount += 1;
        await options.onEvent?.(event, state);

        if (event.event === 'on_chat_model_stream') {
            const delta = extractStreamChunkText(event.data?.chunk?.content);
            if (!delta) {
                continue;
            }

            state.rawStreamResponse += delta;
            const candidate = options.sanitizeText(state.rawStreamResponse);
            if (!candidate) {
                continue;
            }

            const shouldAccept = options.shouldAcceptVisibleText
                ? options.shouldAcceptVisibleText(candidate, state)
                : true;
            if (!shouldAccept) {
                continue;
            }

            const previousVisibleResponse = state.visibleResponse;
            state.visibleResponse = candidate;
            const visibleDelta = previousVisibleResponse && candidate.startsWith(previousVisibleResponse)
                ? candidate.slice(previousVisibleResponse.length)
                : candidate;

            await options.onVisibleResponseUpdated?.({
                state,
                candidate,
                previousVisibleResponse,
                delta: visibleDelta,
            });
            continue;
        }

        if (event.event === 'on_tool_start') {
            state.sawToolCall = true;
            await options.onToolStart?.(event, state);
            continue;
        }

        if (event.event === 'on_tool_end') {
            const toolOutput = options.sanitizeText(extractReplyTextFromEventData(event.data));
            if (toolOutput) {
                state.lastToolOutputFromEvents = toolOutput;
            }
            await options.onToolEnd?.(event, state);
            continue;
        }

        if (event.event === 'on_chat_model_end' || event.event === 'on_chain_end') {
            const extracted = options.sanitizeText(extractReplyTextFromEventData(event.data));
            if (extracted) {
                state.finalOutputFromEvents = extracted;
            }

            const eventData = event.data as { output?: { messages?: unknown[] }; messages?: unknown[] } | undefined;
            const outputMessages = Array.isArray(eventData?.output?.messages)
                ? eventData.output.messages
                : Array.isArray(eventData?.messages)
                    ? eventData.messages
                    : null;
            if (outputMessages) {
                const bestFromMessages = extractBestReadableReplyFromMessages(outputMessages);
                if (bestFromMessages) {
                    state.finalOutputFromEvents = bestFromMessages;
                }
            }
        }
    }

    return state;
}

export function pickFinalStreamResponse(
    state: AgentStreamState,
    fallbackCandidates: string[] = [],
): string {
    return pickBestUserFacingResponse([
        state.finalOutputFromEvents,
        state.visibleResponse,
        state.rawStreamResponse,
        ...fallbackCandidates,
    ], {
        sawToolCall: state.sawToolCall,
    });
}

export function pickInvokeResponse(result: RuntimeAgentInvokeResult): string {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    let lastMessageText = '';

    if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1] as { content?: unknown };
        lastMessageText = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : (JSON.stringify(lastMessage.content) || '');
    }

    return pickBestUserFacingResponse([
        lastMessageText,
        extractBestReadableReplyFromMessages(messages),
    ]);
}

export async function executeMemoryFlushCore(params: {
    agent: RuntimeAgent;
    threadId: string;
    recursionLimit: number;
    flushState: MemoryFlushState;
    compactionConfig: CompactionConfig;
    preserveTokenCount?: boolean;
    version?: string;
}): Promise<{
    nextState: MemoryFlushState;
    visibleOutput: string;
    noReply: boolean;
}> {
    const tokensBeforeFlush = params.flushState.totalTokens;
    const result = await params.agent.invoke(
        {
            messages: [
                { role: 'user', content: buildMemoryFlushPrompt() },
            ],
        },
        {
            configurable: { thread_id: params.threadId },
            recursionLimit: params.recursionLimit,
            ...(params.version ? { version: params.version } : {}),
        },
    );

    const visibleOutput = pickInvokeResponse(result);
    const noReply = isNoReplyResponse(visibleOutput);
    const markedState = markFlushCompleted(params.flushState);
    const nextState = params.preserveTokenCount
        ? setTotalTokens(markedState, tokensBeforeFlush, params.compactionConfig)
        : markedState;

    return {
        nextState,
        visibleOutput,
        noReply,
    };
}
