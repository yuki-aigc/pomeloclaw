import { AsyncLocalStorage } from 'node:async_hooks';

export interface DingTalkConversationContext {
    conversationId: string;
    isDirect: boolean;
    senderId: string;
    senderName: string;
    sessionWebhook: string;
    workspaceRoot?: string;
    pendingReplyFiles?: string[];
}

const conversationContextStorage = new AsyncLocalStorage<DingTalkConversationContext>();

export function withDingTalkConversationContext<T>(
    context: DingTalkConversationContext,
    fn: () => Promise<T>
): Promise<T> {
    return conversationContextStorage.run(context, fn);
}

export function getDingTalkConversationContext(): DingTalkConversationContext | undefined {
    return conversationContextStorage.getStore();
}

export function queueDingTalkReplyFile(filePath: string): boolean {
    const context = conversationContextStorage.getStore();
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

export function consumeQueuedDingTalkReplyFiles(): string[] {
    const context = conversationContextStorage.getStore();
    if (!context || !Array.isArray(context.pendingReplyFiles) || context.pendingReplyFiles.length === 0) {
        return [];
    }
    const files = [...context.pendingReplyFiles];
    context.pendingReplyFiles.length = 0;
    return files;
}
