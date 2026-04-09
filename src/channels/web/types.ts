import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

export interface WebLogger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}

export interface WebTokenUsagePayload {
    inputTokens: number;
    outputTokens: number;
    contextTokens: number;
    contextWindow: number;
    contextUsagePercent: number;
    contextRemainingTokens: number;
    contextRemainingPercent: number;
    hardContextBudget: number;
    hardContextRemainingTokens: number;
    autoCompactThreshold: number;
    autoCompactRemainingTokens: number;
    flushCount: number;
    flushCycleArmed: boolean;
    updatedAt: number;
    formatted: {
        inputTokens: string;
        outputTokens: string;
        contextTokens: string;
        contextWindow: string;
        contextRemainingTokens: string;
        hardContextBudget: string;
        autoCompactThreshold: string;
    };
}

export interface WebHelloPayload {
    type: 'hello';
    token?: string;
    client_id?: string;
    clientId?: string;
    user_id?: string;
    userId?: string;
    nick_name?: string;
    nickName?: string;
    userName?: string;
    session_id?: string;
    session_title?: string;
    sessionTitle?: string;
    conversationId?: string;
    conversationTitle?: string;
    isDirect?: boolean;
    metadata?: Record<string, unknown>;
}

export interface WebMessagePayload {
    type: 'message';
    request_id?: string;
    message_id?: string;
    messageId?: string;
    idempotency_key?: string;
    idempotencyKey?: string;
    timestamp?: number;
    session_id?: string;
    session_title?: string;
    sessionTitle?: string;
    conversationId?: string;
    conversationTitle?: string;
    isDirect?: boolean;
    user_id?: string;
    senderId?: string;
    sender_id?: string;
    nick_name?: string;
    nickName?: string;
    senderName?: string;
    text?: string;
    attachments?: WebInboundAttachmentPayload[];
    metadata?: Record<string, unknown>;
}

export interface WebPingPayload {
    type: 'ping';
    timestamp?: number;
}

export interface WebCancelPayload {
    type: 'cancel';
    request_id?: string;
    requestId?: string;
    message_id?: string;
    messageId?: string;
    session_id?: string;
    sessionId?: string;
    conversationId?: string;
    metadata?: Record<string, unknown>;
}

export type WebClientEnvelope = WebHelloPayload | WebMessagePayload | WebPingPayload | WebCancelPayload;

export interface WebServerEnvelope {
    type: string;
    [key: string]: unknown;
}

export interface WebAttachmentPayload {
    id: string;
    name: string;
    url: string;
    sizeBytes: number;
    mimeType: string;
}

export interface WebUploadedAttachmentPayload {
    upload_id: string;
    uploadId: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    mime_type: string;
    mediaType: 'image' | 'file';
    media_type: 'image' | 'file';
}

export interface WebAttachmentRecord extends WebAttachmentPayload {
    path: string;
    createdAt: number;
    expiresAt: number;
}

export interface WebInboundAttachmentPayload {
    upload_id?: string;
    uploadId?: string;
}

export interface WebUploadRecord {
    id: string;
    name: string;
    path: string;
    sizeBytes: number;
    mimeType: string;
    mediaType: 'image' | 'file';
    createdAt: number;
    expiresAt: number;
    userId?: string;
    sessionId?: string;
}

export interface WebConnectionState {
    connectionId: string;
    socket: WebSocket;
    isAlive: boolean;
    authenticated: boolean;
    request: IncomingMessage;
    clientId?: string;
    userId?: string;
    userName?: string;
    conversationId?: string;
    conversationTitle?: string;
    isDirect?: boolean;
}
