import { AsyncLocalStorage } from 'node:async_hooks';

export interface DingTalkConversationContext {
    conversationId: string;
    isDirect: boolean;
    senderId: string;
    senderName: string;
    sessionWebhook: string;
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
