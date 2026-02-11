export interface GatewayLogger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}

export interface ChannelCapabilities {
    supportsStreamingReply: boolean;
    supportsApprovalFlow: boolean;
    supportsAttachmentReply: boolean;
    supportsProactiveMessage: boolean;
}

export interface ChannelAttachment {
    name: string;
    mimeType?: string;
    url?: string;
    path?: string;
    metadata?: Record<string, unknown>;
}

export interface ChannelInboundMessage {
    channel: string;
    messageId: string;
    idempotencyKey?: string;
    timestamp: number;
    conversationId: string;
    conversationTitle?: string;
    isDirect: boolean;
    senderId: string;
    senderName: string;
    sessionWebhook?: string;
    text: string;
    messageType?: string;
    attachments?: ChannelAttachment[];
    workspaceRoot?: string;
    metadata?: Record<string, unknown>;
    raw?: unknown;
}

export interface ChannelOutboundMessage {
    text: string;
    title?: string;
    useMarkdown?: boolean;
    atUserId?: string | null;
    attachments?: string[];
    metadata?: Record<string, unknown>;
}

export interface ChannelReplyRequest {
    inbound: ChannelInboundMessage;
    message: ChannelOutboundMessage;
}

export interface ChannelProactiveRequest {
    channel: string;
    target: string;
    message: ChannelOutboundMessage;
}

export interface GatewayProcessResult {
    reply?: ChannelOutboundMessage | null;
    skipReply?: boolean;
}

export interface GatewayDispatchResult {
    status: 'processed' | 'duplicate' | 'skipped' | 'error';
    reason?: string;
}

export interface ChannelAdapterRuntime {
    onInbound: (message: ChannelInboundMessage) => Promise<GatewayDispatchResult>;
    logger: GatewayLogger;
}

export interface ChannelAdapter {
    readonly channel: string;
    readonly capabilities: ChannelCapabilities;
    start: (runtime: ChannelAdapterRuntime) => Promise<void>;
    stop: () => Promise<void>;
    sendReply: (request: ChannelReplyRequest) => Promise<void>;
    sendProactive?: (request: ChannelProactiveRequest) => Promise<void>;
}

export interface GatewayServiceOptions {
    onProcessInbound: (message: ChannelInboundMessage) => Promise<GatewayProcessResult | void>;
    logger?: Partial<GatewayLogger>;
    dedupeTtlMs?: number;
    maxDedupeKeys?: number;
}
