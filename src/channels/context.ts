import { AsyncLocalStorage } from 'node:async_hooks';

export interface ChannelConversationContext {
    channel: string;
    conversationId: string;
    isDirect: boolean;
    senderId: string;
    senderName: string;
    sessionWebhook?: string;
    workspaceRoot?: string;
    pendingReplyFiles?: string[];
    abortSignal?: AbortSignal;
    requestId?: string;
}

const channelContextStorage = new AsyncLocalStorage<ChannelConversationContext>();

export function withChannelConversationContext<T>(
    context: ChannelConversationContext,
    fn: () => Promise<T>
): Promise<T> {
    return channelContextStorage.run(context, fn);
}

export function getChannelConversationContext(): ChannelConversationContext | undefined {
    return channelContextStorage.getStore();
}

export function withChannelAbortSignal<T>(
    abortSignal: AbortSignal,
    requestId: string,
    fn: () => Promise<T>
): Promise<T> {
    const current = channelContextStorage.getStore();
    if (!current) {
        return fn();
    }
    return channelContextStorage.run(
        {
            ...current,
            abortSignal,
            requestId,
        },
        fn,
    );
}

export function getChannelAbortSignal(): AbortSignal | undefined {
    return channelContextStorage.getStore()?.abortSignal;
}

export function queueChannelReplyFile(filePath: string): boolean {
    const context = channelContextStorage.getStore();
    if (!context) return false;
    const normalized = filePath.trim();
    if (!normalized) return false;
    if (!Array.isArray(context.pendingReplyFiles)) {
        context.pendingReplyFiles = [];
    }
    if (!context.pendingReplyFiles.includes(normalized)) {
        context.pendingReplyFiles.push(normalized);
    }
    return true;
}

export function consumeQueuedChannelReplyFiles(): string[] {
    const context = channelContextStorage.getStore();
    if (!context || !Array.isArray(context.pendingReplyFiles) || context.pendingReplyFiles.length === 0) {
        return [];
    }
    const files = [...context.pendingReplyFiles];
    context.pendingReplyFiles.length = 0;
    return files;
}
