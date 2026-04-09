export interface WebConversationExecution {
    requestId: string;
    sourceMessageId: string;
    startedAt: number;
    cancelledAt?: number;
    abortController?: AbortController;
}

export interface WebCancelResult {
    ok: boolean;
    requestId?: string;
    alreadyCancelled?: boolean;
    reason?: string;
}

export class WebConversationCancelRegistry {
    private readonly active = new Map<string, WebConversationExecution>();

    start(
        conversationId: string,
        requestId: string,
        abortController?: AbortController,
        now: number = Date.now(),
    ): WebConversationExecution {
        const execution: WebConversationExecution = {
            requestId,
            sourceMessageId: requestId,
            startedAt: now,
            abortController,
        };
        this.active.set(conversationId, execution);
        return execution;
    }

    get(conversationId: string): WebConversationExecution | null {
        return this.active.get(conversationId) || null;
    }

    cancel(conversationId: string, requestId?: string, now: number = Date.now()): WebCancelResult {
        const current = this.active.get(conversationId);
        if (!current) {
            return {
                ok: false,
                reason: '当前会话没有正在执行的请求',
            };
        }

        if (requestId && current.requestId !== requestId) {
            return {
                ok: false,
                requestId: current.requestId,
                reason: `当前正在执行的请求不是 ${requestId}`,
            };
        }

        if (current.cancelledAt) {
            return {
                ok: true,
                requestId: current.requestId,
                alreadyCancelled: true,
            };
        }

        current.cancelledAt = now;
        current.abortController?.abort(new Error(`Web request cancelled: ${current.requestId}`));
        return {
            ok: true,
            requestId: current.requestId,
            alreadyCancelled: false,
        };
    }

    isCancelled(conversationId: string, requestId: string): boolean {
        const current = this.active.get(conversationId);
        return Boolean(current && current.requestId === requestId && current.cancelledAt);
    }

    finish(conversationId: string, requestId: string): void {
        const current = this.active.get(conversationId);
        if (current && current.requestId === requestId) {
            this.active.delete(conversationId);
        }
    }
}
