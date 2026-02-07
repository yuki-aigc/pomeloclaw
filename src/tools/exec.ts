import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecConfig } from '../config.js';
import { checkCommandPolicy } from './exec-policy.js';
import { parseCommandInput } from './command-parser.js';

export interface ExecAuditMetadata {
    callId: string;
    command: string;
    baseCommand: string | null;
    args: string[];
    cwd: string;
    timeoutMs: number;
    shell: false;
    policyMode: 'enforce' | 'deny-only';
    policyStatus: 'allowed' | 'denied' | 'unknown' | 'disabled';
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    riskReasons: string[];
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    pid: number | null;
    ppid: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
}

export interface ExecResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    error?: string;
    timedOut?: boolean;
    metadata: ExecAuditMetadata;
}

export interface ExecOptions {
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxOutputLength?: number;
    policyMode?: 'enforce' | 'deny-only';
    callId?: string;
}

interface OutputBufferState {
    text: string;
    totalLength: number;
    truncated: boolean;
}

/**
 * Append output chunk while capping in-memory buffer size.
 */
function appendOutputChunk(state: OutputBufferState, chunk: string, maxLength: number): void {
    state.totalLength += chunk.length;

    if (state.text.length < maxLength) {
        const remaining = maxLength - state.text.length;
        if (chunk.length <= remaining) {
            state.text += chunk;
        } else {
            state.text += chunk.slice(0, remaining);
            state.truncated = true;
        }
    } else {
        state.truncated = true;
    }

    if (state.totalLength > maxLength) {
        state.truncated = true;
    }
}

/**
 * Format buffered output with truncation metadata.
 */
function finalizeOutput(state: OutputBufferState, maxLength: number): { text: string; truncated: boolean } {
    if (!state.truncated) {
        return { text: state.text, truncated: false };
    }

    const truncateMsg = `\n...[Output truncated. Total length: ${state.totalLength} chars, showing first ${maxLength} chars]`;
    const headLength = Math.max(0, maxLength - truncateMsg.length);
    const head = state.text.slice(0, headLength);

    return {
        text: `${head}${truncateMsg}`,
        truncated: true,
    };
}

/**
 * Execute a command with timeout and output capture
 */
export async function runCommand(
    commandStr: string,
    config: ExecConfig,
    options: ExecOptions = {},
): Promise<ExecResult> {
    const callId = options.callId || `call_${randomUUID().slice(0, 8)}`;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const finalCwd = options.cwd || process.cwd();

    const parsed = parseCommandInput(commandStr);
    const policyMode = options.policyMode ?? 'enforce';
    const policyCheck = checkCommandPolicy(commandStr, config);

    const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;
    const maxOutputLength = Math.max(1, options.maxOutputLength ?? config.maxOutputLength);

    const buildMetadata = (params: {
        finishedAtMs?: number;
        pid?: number | null;
        exitCode?: number | null;
        signal?: NodeJS.Signals | null;
        timedOut?: boolean;
        stdoutTruncated?: boolean;
        stderrTruncated?: boolean;
    }): ExecAuditMetadata => {
        const finishedAtMs = params.finishedAtMs ?? Date.now();
        const finishedAt = new Date(finishedAtMs).toISOString();
        const safeParsed = parsed.ok && parsed.parsed
            ? parsed.parsed
            : { command: policyCheck.baseCommand || '', args: [] as string[] };

        return {
            callId,
            command: commandStr,
            baseCommand: policyCheck.baseCommand,
            args: safeParsed.args,
            cwd: finalCwd,
            timeoutMs,
            shell: false,
            policyMode,
            policyStatus: policyCheck.status,
            riskLevel: policyCheck.risk.level,
            riskReasons: policyCheck.risk.reasons,
            startedAt,
            finishedAt,
            durationMs: Math.max(0, finishedAtMs - startedAtMs),
            pid: params.pid ?? null,
            ppid: process.pid,
            exitCode: params.exitCode ?? null,
            signal: params.signal ?? null,
            timedOut: params.timedOut ?? false,
            stdoutTruncated: params.stdoutTruncated ?? false,
            stderrTruncated: params.stderrTruncated ?? false,
        };
    };

    if (!parsed.ok || !parsed.parsed) {
        return {
            success: false,
            stdout: '',
            stderr: '',
            exitCode: null,
            signal: null,
            error: parsed.error || 'Failed to parse command',
            metadata: buildMetadata({}),
        };
    }

    if (policyMode === 'enforce') {
        if (policyCheck.status !== 'allowed') {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: null,
                signal: null,
                error: policyCheck.reason || 'Command not allowed',
                metadata: buildMetadata({}),
            };
        }
    } else if (policyMode === 'deny-only') {
        if (policyCheck.status === 'denied' || policyCheck.status === 'disabled') {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: null,
                signal: null,
                error: policyCheck.reason || 'Command not allowed',
                metadata: buildMetadata({}),
            };
        }
    }

    const command = parsed.parsed.command;
    const args = parsed.parsed.args;

    return new Promise((resolve) => {
        const stdoutState: OutputBufferState = { text: '', totalLength: 0, truncated: false };
        const stderrState: OutputBufferState = { text: '', totalLength: 0, truncated: false };
        let timedOut = false;
        let settled = false;

        const child = spawn(command, args, {
            cwd: finalCwd,
            env: options.env ? { ...process.env, ...options.env } : process.env,
            shell: false,
        });
        const childPid = child.pid ?? null;

        const timer = setTimeout(() => {
            if (!settled) {
                timedOut = true;
                child.kill('SIGKILL');
            }
        }, timeoutMs);

        child.stdout?.on('data', (data: Buffer) => {
            appendOutputChunk(stdoutState, data.toString(), maxOutputLength);
        });

        child.stderr?.on('data', (data: Buffer) => {
            appendOutputChunk(stderrState, data.toString(), maxOutputLength);
        });

        child.on('error', (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const stdoutTruncated = finalizeOutput(stdoutState, maxOutputLength);
            const stderrTruncated = finalizeOutput(stderrState, maxOutputLength);
            resolve({
                success: false,
                stdout: stdoutTruncated.text,
                stderr: stderrTruncated.text,
                exitCode: null,
                signal: null,
                error: err.message,
                metadata: buildMetadata({
                    finishedAtMs: Date.now(),
                    pid: childPid,
                    stdoutTruncated: stdoutTruncated.truncated,
                    stderrTruncated: stderrTruncated.truncated,
                }),
            });
        });

        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const stdoutTruncated = finalizeOutput(stdoutState, maxOutputLength);
            const stderrTruncated = finalizeOutput(stderrState, maxOutputLength);
            resolve({
                success: code === 0 && !timedOut,
                stdout: stdoutTruncated.text,
                stderr: stderrTruncated.text,
                exitCode: code,
                signal,
                timedOut,
                error: timedOut ? `Command timed out after ${timeoutMs}ms` : undefined,
                metadata: buildMetadata({
                    finishedAtMs: Date.now(),
                    pid: childPid,
                    exitCode: code,
                    signal,
                    timedOut,
                    stdoutTruncated: stdoutTruncated.truncated,
                    stderrTruncated: stderrTruncated.truncated,
                }),
            });
        });
    });
}

/**
 * Create a bound exec function with config
 */
export function createExecRunner(config: ExecConfig) {
    return (commandStr: string, options?: ExecOptions) => runCommand(commandStr, config, options);
}
