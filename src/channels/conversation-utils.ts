import {
    buildSessionStartupMemoryInjection,
    buildUserMessagesWithMemoryPolicy,
    hasMemoryRecallIntent,
} from '../prompt/memory-policy.js';

export interface PreparedConversationUserMessages {
    enforceMemorySearch: boolean;
    startupMemoryInjection: string | null;
    userMessages: Array<{ role: 'user'; content: string }>;
}

export async function prepareConversationUserMessages(params: {
    userText: string;
    workspacePath: string;
    scopeKey: string;
    includeStartupMemory: boolean;
}): Promise<PreparedConversationUserMessages> {
    const enforceMemorySearch = hasMemoryRecallIntent(params.userText);
    const startupMemoryInjection = params.includeStartupMemory
        ? await buildSessionStartupMemoryInjection({
            workspacePath: params.workspacePath,
            scopeKey: params.scopeKey,
        })
        : null;

    return {
        enforceMemorySearch,
        startupMemoryInjection,
        userMessages: buildUserMessagesWithMemoryPolicy(params.userText, {
            enforceMemorySearch,
            startupMemoryInjection,
        }),
    };
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

export function enqueueConversationTask(
    queue: Map<string, Promise<void>>,
    conversationId: string,
    task: () => Promise<void>,
): Promise<void> {
    const previous = queue.get(conversationId) ?? Promise.resolve();
    const next = previous.then(task, task).finally(() => {
        if (queue.get(conversationId) === next) {
            queue.delete(conversationId);
        }
    });
    queue.set(conversationId, next);
    return next;
}
