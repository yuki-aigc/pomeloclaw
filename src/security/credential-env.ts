import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_CREDENTIALS_ENV_PATH = '~/.srebot/credentials/.env';

let cachedCredentialEnv: Record<string, string> | null = null;
let cachedCredentialEnvPath: string | null = null;
let envInjectionLock: Promise<void> = Promise.resolve();

function resolvePathWithHome(pathValue: string): string {
    if (pathValue.startsWith('~/')) {
        return resolve(homedir(), pathValue.slice(2));
    }
    if (pathValue === '~') {
        return homedir();
    }
    return resolve(pathValue);
}

function resolveCredentialEnvPath(): string {
    const configuredPath = process.env.SREBOT_CREDENTIALS_ENV_PATH?.trim();
    return resolvePathWithHome(configuredPath || DEFAULT_CREDENTIALS_ENV_PATH);
}

function parseEnvValue(raw: string): string {
    const trimmed = raw.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        const body = trimmed.slice(1, -1);
        if (trimmed.startsWith('"')) {
            return body
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"');
        }
        return body;
    }
    return trimmed;
}

function parseDotEnv(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
        const eqIndex = normalized.indexOf('=');
        if (eqIndex <= 0) {
            continue;
        }

        const key = normalized.slice(0, eqIndex).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            continue;
        }

        const rawValue = normalized.slice(eqIndex + 1);
        result[key] = parseEnvValue(rawValue);
    }

    return result;
}

export function getCredentialEnv(): Record<string, string> {
    const envPath = resolveCredentialEnvPath();
    if (cachedCredentialEnv && cachedCredentialEnvPath === envPath) {
        return cachedCredentialEnv;
    }

    if (!existsSync(envPath)) {
        cachedCredentialEnv = {};
        cachedCredentialEnvPath = envPath;
        return cachedCredentialEnv;
    }

    try {
        const content = readFileSync(envPath, 'utf-8');
        cachedCredentialEnv = parseDotEnv(content);
        cachedCredentialEnvPath = envPath;
    } catch (error) {
        console.warn(
            `[Security] Failed to read credential env file at ${envPath}:`,
            error instanceof Error ? error.message : String(error)
        );
        cachedCredentialEnv = {};
        cachedCredentialEnvPath = envPath;
    }

    return cachedCredentialEnv;
}

export function readEnvWithCredentialFallback(name: string): string | undefined {
    const processValue = process.env[name];
    if (typeof processValue === 'string' && processValue.trim()) {
        return processValue;
    }

    const credentialValue = getCredentialEnv()[name];
    if (typeof credentialValue === 'string' && credentialValue.trim()) {
        return credentialValue;
    }

    return undefined;
}

export function buildEnvWithCredentialFallback(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...baseEnv };
    const credentialEnv = getCredentialEnv();

    for (const [key, value] of Object.entries(credentialEnv)) {
        const currentValue = merged[key];
        if (typeof currentValue === 'string' && currentValue.trim()) {
            continue;
        }
        merged[key] = value;
    }

    return merged;
}

export async function enterTemporaryCredentialEnv(): Promise<() => void> {
    const credentialEnv = getCredentialEnv();
    const keys = Object.keys(credentialEnv);
    if (keys.length === 0) {
        return () => { /* no-op */ };
    }

    let releaseLock: (() => void) | null = null;
    const previousLock = envInjectionLock;
    envInjectionLock = new Promise<void>((resolvePromise) => {
        releaseLock = resolvePromise;
    });

    await previousLock;

    const injectedKeys: string[] = [];
    const previousValues = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(credentialEnv)) {
        const currentValue = process.env[key];
        if (typeof currentValue === 'string' && currentValue.trim()) {
            continue;
        }
        previousValues.set(key, currentValue);
        process.env[key] = value;
        injectedKeys.push(key);
    }

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;

        for (const key of injectedKeys) {
            const previousValue = previousValues.get(key);
            if (previousValue === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = previousValue;
            }
        }

        releaseLock?.();
    };
}

export async function withTemporaryCredentialEnv<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await enterTemporaryCredentialEnv();
    try {
        return await fn();
    } finally {
        release();
    }
}
