import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface SkillMonitorLogger {
    debug?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
}

export interface SkillDirectoryMonitor {
    close: () => void;
    pollNow: () => Promise<void>;
}

async function buildSnapshot(rootDir: string): Promise<string> {
    if (!existsSync(rootDir)) {
        return 'missing';
    }

    const entries: string[] = [];

    async function walk(currentDir: string): Promise<void> {
        const dirEntries = await readdir(currentDir, { withFileTypes: true });
        dirEntries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of dirEntries) {
            const absPath = path.join(currentDir, entry.name);
            const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                entries.push(`d:${relPath}`);
                await walk(absPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            const fileStat = await stat(absPath);
            entries.push(`f:${relPath}:${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`);
        }
    }

    await walk(rootDir);
    return entries.join('\n');
}

export function createSkillDirectoryMonitor(params: {
    skillsDir: string;
    onChange: () => Promise<void> | void;
    intervalMs?: number;
    logger?: SkillMonitorLogger;
}): SkillDirectoryMonitor {
    const intervalMs = Math.max(1000, Math.floor(params.intervalMs ?? 3000));
    let closed = false;
    let snapshot: string | null = null;
    let polling = false;

    const pollNow = async (): Promise<void> => {
        if (closed || polling) return;
        polling = true;
        try {
            const nextSnapshot = await buildSnapshot(params.skillsDir);
            if (snapshot !== null && nextSnapshot !== snapshot) {
                params.logger?.debug?.(`[Skills] detected on-disk changes: ${params.skillsDir}`);
                await params.onChange();
            }
            snapshot = nextSnapshot;
        } catch (error) {
            params.logger?.warn?.(
                `[Skills] monitor scan failed: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            polling = false;
        }
    };

    const timer = setInterval(() => {
        void pollNow();
    }, intervalMs);
    timer.unref?.();

    void pollNow();

    return {
        close: () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
        },
        pollNow,
    };
}
