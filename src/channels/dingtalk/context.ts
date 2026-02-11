import {
    withChannelConversationContext,
    getChannelConversationContext,
    queueChannelReplyFile,
    consumeQueuedChannelReplyFiles,
} from '../context.js';

export interface DingTalkConversationContext {
    conversationId: string;
    isDirect: boolean;
    senderId: string;
    senderName: string;
    sessionWebhook: string;
    workspaceRoot?: string;
    pendingReplyFiles?: string[];
}

export function withDingTalkConversationContext<T>(
    context: DingTalkConversationContext,
    fn: () => Promise<T>
): Promise<T> {
    return withChannelConversationContext(
        {
            channel: 'dingtalk',
            ...context,
        },
        fn
    );
}

export function getDingTalkConversationContext(): DingTalkConversationContext | undefined {
    const context = getChannelConversationContext();
    if (!context || context.channel !== 'dingtalk') {
        return undefined;
    }
    return {
        conversationId: context.conversationId,
        isDirect: context.isDirect,
        senderId: context.senderId,
        senderName: context.senderName,
        sessionWebhook: context.sessionWebhook || '',
        workspaceRoot: context.workspaceRoot,
        pendingReplyFiles: context.pendingReplyFiles,
    };
}

export function queueDingTalkReplyFile(filePath: string): boolean {
    const context = getChannelConversationContext();
    if (!context || context.channel !== 'dingtalk') {
        return false;
    }
    return queueChannelReplyFile(filePath);
}

export function consumeQueuedDingTalkReplyFiles(): string[] {
    const context = getChannelConversationContext();
    if (!context || context.channel !== 'dingtalk') {
        return [];
    }
    return consumeQueuedChannelReplyFiles();
}
