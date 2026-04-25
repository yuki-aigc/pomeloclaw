import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { enqueueConversationTask } from '../channels/conversation-utils.js';
import type {
    AgentHookRequest,
    HookAcceptedResponse,
    HookTaskCallbackState,
    HookLogger,
    HookTaskQueryResponse,
    HookTaskCallbackBody,
    HookTaskExecutionResult,
    HookTaskStatus,
} from './types.js';

const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 10000;
const DEFAULT_CALLBACK_RETRIES = 2;
const DEFAULT_CALLBACK_RETRY_DELAY_MS = 1000;

type HookFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

class AsyncSemaphore {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active += 1;
            return;
        }

        await new Promise<void>((resolve) => {
            this.waiters.push(() => {
                this.active += 1;
                resolve();
            });
        });
    }

    release(): void {
        this.active = Math.max(0, this.active - 1);
        const next = this.waiters.shift();
        next?.();
    }
}

export interface HookTaskManagerOptions {
    logger: HookLogger;
    maxConcurrentTasks?: number;
    taskTtlMs?: number;
    callbackDefaults?: {
        timeoutMs?: number;
        retries?: number;
        retryDelayMs?: number;
    };
    executeTask: (request: AgentHookRequest) => Promise<HookTaskExecutionResult>;
    fetchImpl?: HookFetch;
}

export interface NormalizedAgentHookRequest extends AgentHookRequest {}

export interface HookTaskSnapshot {
    taskId: string;
    request: NormalizedAgentHookRequest;
    status: HookTaskStatus;
    acceptedAt: number;
    startedAt?: number;
    finishedAt?: number;
    result?: HookTaskExecutionResult;
    error?: string;
    callback: {
        url: string;
        timeoutMs: number;
        maxRetries: number;
        retryDelayMs: number;
        attempts: number;
        delivered: boolean;
        lastAttemptAt?: number;
        deliveredAt?: number;
        lastError?: string;
    };
}

function pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (trimmed) {
            return trimmed;
        }
    }
    return undefined;
}

function normalizeHeaders(input: unknown, fieldName: string): Record<string, string> | undefined {
    if (input === undefined) {
        return undefined;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(`${fieldName} 必须是对象`);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value !== 'string') {
            throw new Error(`${fieldName}.${key} 必须是字符串`);
        }
        const headerName = key.trim();
        if (!headerName) {
            continue;
        }
        headers[headerName] = value;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}

export function normalizeAgentHookRequest(input: unknown): NormalizedAgentHookRequest {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('请求体必须是 JSON 对象');
    }

    const body = input as Record<string, unknown>;
    const requestId = pickString(body.request_id, body.requestId, body.event_id, body.eventId);
    if (!requestId) {
        throw new Error('request_id 不能为空');
    }

    const sessionKey = pickString(body.session_key, body.sessionKey);
    if (!sessionKey) {
        throw new Error('session_key 不能为空');
    }

    const prompt = pickString(body.prompt);
    if (!prompt) {
        throw new Error('prompt 不能为空');
    }

    const callbackInput = body.callback;
    if (!callbackInput || typeof callbackInput !== 'object' || Array.isArray(callbackInput)) {
        throw new Error('callback 不能为空，且必须是对象');
    }
    const callbackBody = callbackInput as Record<string, unknown>;
    const callbackUrl = pickString(callbackBody.url);
    if (!callbackUrl) {
        throw new Error('callback.url 不能为空');
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(callbackUrl);
    } catch {
        throw new Error('callback.url 不是合法 URL');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('callback.url 仅支持 http/https');
    }

    const metadata = body.metadata;
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) {
        throw new Error('metadata 必须是对象');
    }

    const timeoutMsRaw = Number(callbackBody.timeout_ms ?? callbackBody.timeoutMs);
    const retriesRaw = Number(callbackBody.retries);
    const retryDelayMsRaw = Number(callbackBody.retry_delay_ms ?? callbackBody.retryDelayMs);

    return {
        requestId,
        sessionKey,
        prompt,
        payload: body.payload,
        metadata: metadata as Record<string, unknown> | undefined,
        callback: {
            url: parsedUrl.toString(),
            token: pickString(callbackBody.token),
            headers: normalizeHeaders(callbackBody.headers, 'callback.headers'),
            timeoutMs: Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : undefined,
            retries: Number.isFinite(retriesRaw) && retriesRaw >= 0 ? Math.floor(retriesRaw) : undefined,
            retryDelayMs: Number.isFinite(retryDelayMsRaw) && retryDelayMsRaw >= 0 ? Math.floor(retryDelayMsRaw) : undefined,
        },
    };
}

function isoOrUndefined(value?: number): string | undefined {
    return typeof value === 'number' ? new Date(value).toISOString() : undefined;
}

function buildCallbackStateView(task: HookTaskSnapshot): HookTaskCallbackState {
    return {
        url: task.callback.url,
        timeout_ms: task.callback.timeoutMs,
        max_retries: task.callback.maxRetries,
        retry_delay_ms: task.callback.retryDelayMs,
        attempts: task.callback.attempts,
        delivered: task.callback.delivered,
        last_attempt_at: isoOrUndefined(task.callback.lastAttemptAt),
        delivered_at: isoOrUndefined(task.callback.deliveredAt),
        last_error: task.callback.lastError,
    };
}

export function buildHookTaskCallbackBody(task: HookTaskSnapshot): HookTaskCallbackBody {
    return {
        schema_version: 'v1',
        event: 'hook.task.completed',
        task_id: task.taskId,
        request_id: task.request.requestId,
        session_key: task.request.sessionKey,
        status: task.status === 'succeeded' ? 'succeeded' : 'failed',
        accepted_at: new Date(task.acceptedAt).toISOString(),
        started_at: isoOrUndefined(task.startedAt),
        finished_at: new Date(task.finishedAt ?? Date.now()).toISOString(),
        result: task.result
            ? {
                text: task.result.text,
                metadata: task.result.metadata,
            }
            : null,
        error: task.status === 'succeeded'
            ? null
            : { message: task.error || 'unknown error' },
        metadata: task.request.metadata,
    };
}

export function buildHookTaskQueryResponse(task: HookTaskSnapshot): HookTaskQueryResponse {
    return {
        ok: true,
        task: {
            task_id: task.taskId,
            request_id: task.request.requestId,
            session_key: task.request.sessionKey,
            status: task.status,
            accepted_at: new Date(task.acceptedAt).toISOString(),
            started_at: isoOrUndefined(task.startedAt),
            finished_at: isoOrUndefined(task.finishedAt),
            prompt: task.request.prompt,
            payload: task.request.payload,
            metadata: task.request.metadata,
            result: task.result
                ? {
                    text: task.result.text,
                    metadata: task.result.metadata,
                }
                : null,
            error: task.error ? { message: task.error } : null,
            callback: buildCallbackStateView(task),
        },
    };
}

async function postCallback(params: {
    fetchImpl: HookFetch;
    request: NormalizedAgentHookRequest;
    body: HookTaskCallbackBody;
    timeoutMs: number;
}): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    timer.unref?.();

    try {
        const headers: Record<string, string> = {
            'content-type': 'application/json; charset=utf-8',
            ...(params.request.callback.headers || {}),
        };
        if (params.request.callback.token) {
            headers.authorization = `Bearer ${params.request.callback.token}`;
        }

        const response = await params.fetchImpl(params.request.callback.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(params.body),
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`callback status=${response.status}`);
        }
    } finally {
        clearTimeout(timer);
    }
}

export class HookTaskManager {
    private readonly logger: HookLogger;
    private readonly taskTtlMs: number;
    private readonly callbackDefaults: Required<NonNullable<HookTaskManagerOptions['callbackDefaults']>>;
    private readonly executeTask: HookTaskManagerOptions['executeTask'];
    private readonly fetchImpl: HookFetch;
    private readonly semaphore: AsyncSemaphore;
    private readonly sessionQueue = new Map<string, Promise<void>>();
    private readonly tasksByRequestId = new Map<string, HookTaskSnapshot>();
    private readonly pendingExecutions = new Set<Promise<void>>();
    private stopped = false;

    constructor(options: HookTaskManagerOptions) {
        this.logger = options.logger;
        this.taskTtlMs = Math.max(60_000, Math.floor(options.taskTtlMs ?? DEFAULT_TASK_TTL_MS));
        this.callbackDefaults = {
            timeoutMs: Math.max(1000, Math.floor(options.callbackDefaults?.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS)),
            retries: Math.max(0, Math.floor(options.callbackDefaults?.retries ?? DEFAULT_CALLBACK_RETRIES)),
            retryDelayMs: Math.max(0, Math.floor(options.callbackDefaults?.retryDelayMs ?? DEFAULT_CALLBACK_RETRY_DELAY_MS)),
        };
        this.executeTask = options.executeTask;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.semaphore = new AsyncSemaphore(Math.max(1, Math.floor(options.maxConcurrentTasks ?? 1)));
    }

    async accept(rawInput: unknown): Promise<HookAcceptedResponse> {
        if (this.stopped) {
            throw new Error('hooks service is shutting down');
        }

        this.cleanupExpiredTasks();
        const request = normalizeAgentHookRequest(rawInput);
        const existing = this.tasksByRequestId.get(request.requestId);
        if (existing) {
            this.logger.info(
                `[Hooks] duplicate request accepted request_id=${request.requestId} task_id=${existing.taskId} status=${existing.status}`
            );
            return {
                ok: true,
                accepted: true,
                duplicate: true,
                task_id: existing.taskId,
                request_id: existing.request.requestId,
                session_key: existing.request.sessionKey,
                status: existing.status,
                accepted_at: new Date(existing.acceptedAt).toISOString(),
            };
        }

        const task: HookTaskSnapshot = {
            taskId: `hook_${randomUUID().replace(/-/g, '')}`,
            request,
            status: 'accepted',
            acceptedAt: Date.now(),
            callback: {
                url: request.callback.url,
                timeoutMs: request.callback.timeoutMs ?? this.callbackDefaults.timeoutMs,
                maxRetries: request.callback.retries ?? this.callbackDefaults.retries,
                retryDelayMs: request.callback.retryDelayMs ?? this.callbackDefaults.retryDelayMs,
                attempts: 0,
                delivered: false,
            },
        };
        this.tasksByRequestId.set(task.request.requestId, task);

        this.logger.info(
            `[Hooks] accepted task task_id=${task.taskId} request_id=${task.request.requestId} session_key=${task.request.sessionKey}`
        );

        const execution = this.executeQueued(task)
            .catch((error) => {
                this.logger.error(
                    `[Hooks] detached execution failed task_id=${task.taskId}: ${error instanceof Error ? error.message : String(error)}`
                );
            })
            .finally(() => {
                this.pendingExecutions.delete(execution);
            });
        this.pendingExecutions.add(execution);

        return {
            ok: true,
            accepted: true,
            duplicate: false,
            task_id: task.taskId,
            request_id: task.request.requestId,
            session_key: task.request.sessionKey,
            status: task.status,
            accepted_at: new Date(task.acceptedAt).toISOString(),
        };
    }

    getTask(requestId: string): HookTaskSnapshot | undefined {
        return this.tasksByRequestId.get(requestId.trim());
    }

    pendingCount(): number {
        return this.pendingExecutions.size;
    }

    async waitForIdle(): Promise<void> {
        await Promise.allSettled(Array.from(this.pendingExecutions));
    }

    stop(): void {
        this.stopped = true;
    }

    private executeQueued(task: HookTaskSnapshot): Promise<void> {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                const queued = enqueueConversationTask(this.sessionQueue, task.request.sessionKey, async () => {
                    await this.semaphore.acquire();
                    try {
                        await this.runTask(task);
                    } finally {
                        this.semaphore.release();
                    }
                });
                queued.finally(resolve);
            }, 0);
            timer.unref?.();
        });
    }

    private async runTask(task: HookTaskSnapshot): Promise<void> {
        task.status = 'running';
        task.startedAt = Date.now();
        this.logger.info(`[Hooks] task running task_id=${task.taskId} request_id=${task.request.requestId}`);

        try {
            const result = await this.executeTask(task.request);
            task.status = 'succeeded';
            task.finishedAt = Date.now();
            task.result = result;
            this.logger.info(`[Hooks] task succeeded task_id=${task.taskId} request_id=${task.request.requestId}`);
        } catch (error) {
            task.status = 'failed';
            task.finishedAt = Date.now();
            task.error = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `[Hooks] task failed task_id=${task.taskId} request_id=${task.request.requestId} error=${task.error}`
            );
        }

        try {
            await this.deliverCallback(task, buildHookTaskCallbackBody(task));
        } catch (error) {
            task.status = 'callback_failed';
            task.error = error instanceof Error ? error.message : String(error);
            this.logger.error(
                `[Hooks] callback failed task_id=${task.taskId} request_id=${task.request.requestId} error=${task.error}`
            );
        }
    }

    private async deliverCallback(task: HookTaskSnapshot, body: HookTaskCallbackBody): Promise<void> {
        const timeoutMs = task.request.callback.timeoutMs ?? this.callbackDefaults.timeoutMs;
        const retries = task.request.callback.retries ?? this.callbackDefaults.retries;
        const retryDelayMs = task.request.callback.retryDelayMs ?? this.callbackDefaults.retryDelayMs;

        for (let attempt = 0; attempt <= retries; attempt += 1) {
            task.callback.attempts = attempt + 1;
            task.callback.lastAttemptAt = Date.now();
            try {
                await postCallback({
                    fetchImpl: this.fetchImpl,
                    request: task.request,
                    body,
                    timeoutMs,
                });
                task.callback.delivered = true;
                task.callback.deliveredAt = Date.now();
                task.callback.lastError = undefined;
                this.logger.info(
                    `[Hooks] callback delivered task_id=${task.taskId} request_id=${task.request.requestId} attempt=${attempt + 1}`
                );
                return;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                task.callback.lastError = message;
                if (attempt >= retries) {
                    throw new Error(message);
                }
                this.logger.warn(
                    `[Hooks] callback retry task_id=${task.taskId} request_id=${task.request.requestId} attempt=${attempt + 1} error=${message}`
                );
                if (retryDelayMs > 0) {
                    await delay(retryDelayMs);
                }
            }
        }
    }

    private cleanupExpiredTasks(now: number = Date.now()): void {
        for (const [requestId, task] of this.tasksByRequestId.entries()) {
            const reference = task.finishedAt ?? task.acceptedAt;
            if (reference + this.taskTtlMs <= now) {
                this.tasksByRequestId.delete(requestId);
            }
        }
    }
}
