export interface HookLogger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}

export interface HookCallbackRequest {
    url: string;
    token?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
}

export interface AgentHookRequest {
    requestId: string;
    sessionKey: string;
    prompt: string;
    payload?: unknown;
    metadata?: Record<string, unknown>;
    callback: HookCallbackRequest;
}

export type HookTaskStatus =
    | 'accepted'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'callback_failed';

export interface HookTaskExecutionResult {
    text: string;
    metadata?: Record<string, unknown>;
}

export interface HookTaskCallbackState {
    url: string;
    timeout_ms: number;
    max_retries: number;
    retry_delay_ms: number;
    attempts: number;
    delivered: boolean;
    last_attempt_at?: string;
    delivered_at?: string;
    last_error?: string;
}

export interface HookAcceptedResponse {
    ok: true;
    accepted: true;
    duplicate: boolean;
    task_id: string;
    request_id: string;
    session_key: string;
    status: HookTaskStatus;
    accepted_at: string;
}

export interface HookTaskCallbackBody {
    schema_version: 'v1';
    event: 'hook.task.completed';
    task_id: string;
    request_id: string;
    session_key: string;
    status: 'succeeded' | 'failed';
    accepted_at: string;
    started_at?: string;
    finished_at: string;
    result: {
        text: string;
        metadata?: Record<string, unknown>;
    } | null;
    error: {
        message: string;
    } | null;
    metadata?: Record<string, unknown>;
}

export interface HookTaskQueryResponse {
    ok: true;
    task: {
        task_id: string;
        request_id: string;
        session_key: string;
        status: HookTaskStatus;
        accepted_at: string;
        started_at?: string;
        finished_at?: string;
        prompt: string;
        payload?: unknown;
        metadata?: Record<string, unknown>;
        result: {
            text: string;
            metadata?: Record<string, unknown>;
        } | null;
        error: {
            message: string;
        } | null;
        callback: HookTaskCallbackState;
    };
}
