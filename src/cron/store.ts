import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { CronRunLogEntry, CronStoreFile } from './types.js';

const CURRENT_VERSION = 1 as const;

export function resolveCronStorePath(input?: string): string {
    const fallback = './workspace/cron/jobs.json';
    return resolve(process.cwd(), (input || fallback).trim());
}

export function resolveCronRunLogPath(storePath: string, input?: string): string {
    if (input && input.trim()) {
        return resolve(process.cwd(), input.trim());
    }
    return resolve(dirname(storePath), 'runs.jsonl');
}

export async function ensureStoreFile(storePath: string): Promise<void> {
    await mkdir(dirname(storePath), { recursive: true });
    if (!existsSync(storePath)) {
        const initial: CronStoreFile = {
            version: CURRENT_VERSION,
            jobs: [],
        };
        await writeFile(storePath, `${JSON.stringify(initial, null, 2)}\n`, 'utf-8');
    }
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
    await ensureStoreFile(storePath);
    const raw = await readFile(storePath, 'utf-8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`cron store JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('cron store 数据格式错误');
    }

    const file = parsed as Partial<CronStoreFile>;
    const jobs = Array.isArray(file.jobs) ? file.jobs : [];
    return {
        version: CURRENT_VERSION,
        jobs,
    };
}

export async function saveCronStore(storePath: string, store: CronStoreFile): Promise<void> {
    await ensureStoreFile(storePath);
    const tmpPath = `${storePath}.tmp`;
    const payload = `${JSON.stringify(store, null, 2)}\n`;
    await writeFile(tmpPath, payload, 'utf-8');
    await rename(tmpPath, storePath);
}

export async function appendCronRunLog(runLogPath: string, entry: CronRunLogEntry): Promise<void> {
    await mkdir(dirname(runLogPath), { recursive: true });
    await writeFile(runLogPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', flag: 'a' });
}
