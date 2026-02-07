/**
 * DingTalk Channel Types
 * Type definitions for DingTalk message handling
 */

/**
 * Token info for caching
 */
export interface TokenInfo {
    accessToken: string;
    expireIn: number;
}

/**
 * DingTalk incoming message (Stream mode)
 */
export interface DingTalkInboundMessage {
    msgId: string;
    msgtype: string;
    createAt: number;
    text?: {
        content: string;
    };
    content?: {
        downloadCode?: string;
        fileName?: string;
        recognition?: string;
        richText?: Array<{
            type: string;
            text?: string;
            atName?: string;
        }>;
    };
    conversationType: string;
    conversationId: string;
    conversationTitle?: string;
    senderId: string;
    senderStaffId?: string;
    senderNick?: string;
    chatbotUserId: string;
    sessionWebhook: string;
}

/**
 * Extracted message content for unified processing
 */
export interface MessageContent {
    text: string;
    mediaPath?: string;
    mediaType?: string;
    messageType: string;
}

/**
 * Send message options
 */
export interface SendMessageOptions {
    title?: string;
    useMarkdown?: boolean;
    atUserId?: string | null;
}

/**
 * Session webhook response body
 */
export interface SessionWebhookBody {
    msgtype: string;
    markdown?: {
        title: string;
        text: string;
    };
    text?: {
        content: string;
    };
    at?: {
        atUserIds: string[];
        isAtAll: boolean;
    };
}

/**
 * Stream callback response
 */
export interface StreamCallbackResponse {
    headers?: {
        messageId?: string;
    };
    data: string;
}

/**
 * Logger interface
 */
export interface Logger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}

/**
 * Session state for tracking conversation context
 */
export interface SessionState {
    threadId: string;
    messageHistory: import('@langchain/core/messages').BaseMessage[];
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    compactionCount: number;
    lastUpdated: number;
}

/**
 * AI Card status constants
 */
export const AICardStatus = {
    PROCESSING: '1',
    INPUTING: '2',
    FINISHED: '3',
    FAILED: '5',
} as const;

/**
 * AI Card state type
 */
export type AICardState = typeof AICardStatus[keyof typeof AICardStatus];

/**
 * AI Card instance
 */
export interface AICardInstance {
    cardInstanceId: string;
    accessToken: string;
    conversationId: string;
    createdAt: number;
    lastUpdated: number;
    state: AICardState;
    targetKey?: string;
}

/**
 * AI Card streaming request
 */
export interface AICardStreamingRequest {
    outTrackId: string;
    guid: string;
    key: string;
    content: string;
    isFull: boolean;
    isFinalize: boolean;
    isError: boolean;
}
