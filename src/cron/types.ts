export type CronSchedule =
    | { kind: 'at'; at: string }
    | { kind: 'every'; everyMs: number; anchorMs: number }
    | { kind: 'cron'; expr: string; timezone?: string };

export type CronScheduleInput =
    | { kind: 'at'; at: string }
    | { kind: 'every'; every: string | number; anchorMs?: number }
    | { kind: 'cron'; expr: string; timezone?: string };

export interface CronPayload {
    kind: 'agentTurn';
    message: string;
}

export interface CronDeliveryConfig {
    target?: string;
    useMarkdown?: boolean;
    title?: string;
}

export interface CronJobState {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: 'ok' | 'error' | 'skipped';
    lastError?: string;
    lastDurationMs?: number;
}

export interface CronJob {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    createdAtMs: number;
    updatedAtMs: number;
    schedule: CronSchedule;
    payload: CronPayload;
    delivery: CronDeliveryConfig;
    state: CronJobState;
}

export interface CronJobCreateInput {
    name: string;
    description?: string;
    enabled?: boolean;
    schedule: CronScheduleInput;
    payload: {
        message: string;
    };
    delivery?: CronDeliveryConfig;
}

export interface CronJobPatchInput {
    name?: string;
    description?: string;
    enabled?: boolean;
    schedule?: CronScheduleInput;
    payload?: {
        message?: string;
    };
    delivery?: CronDeliveryConfig;
}

export interface CronStoreFile {
    version: 1;
    jobs: CronJob[];
}

export interface CronRunResult {
    status: 'ok' | 'error' | 'skipped';
    summary?: string;
    error?: string;
}

export interface CronRunLogEntry {
    timestamp: string;
    jobId: string;
    jobName: string;
    trigger: 'scheduled' | 'manual';
    startedAtMs: number;
    endedAtMs: number;
    durationMs: number;
    status: 'ok' | 'error' | 'skipped';
    summary?: string;
    error?: string;
    nextRunAtMs?: number;
}

export interface CronLogger {
    debug?: (message: string, ...args: unknown[]) => void;
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
}
