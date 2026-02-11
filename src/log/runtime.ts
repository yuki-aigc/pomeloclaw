import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

export interface RuntimeLogWriterOptions {
    prefix: string;
    directory?: string;
}

function todayDateKey(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function safeRenderArg(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return '[unserializable]';
    }
}

export class RuntimeLogWriter {
    readonly filePath: string;
    private writeChain: Promise<void>;
    private writeFailed = false;

    constructor(options: RuntimeLogWriterOptions) {
        const logsDir = path.resolve(process.cwd(), options.directory || 'logs');
        const key = todayDateKey();
        this.filePath = path.resolve(logsDir, `${options.prefix}-${key}.log`);
        this.writeChain = mkdir(logsDir, { recursive: true }).then(() => undefined);
    }

    write(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string, args: unknown[] = []): void {
        const suffix = args.length > 0 ? ` ${args.map((item) => safeRenderArg(item)).join(' ')}` : '';
        const line = `${new Date().toISOString()} [${level}] ${message}${suffix}\n`;
        this.writeChain = this.writeChain
            .then(() => appendFile(this.filePath, line, 'utf8'))
            .catch((error) => {
                if (!this.writeFailed) {
                    this.writeFailed = true;
                    console.error('[RuntimeLog] Failed to append log file:', error instanceof Error ? error.message : String(error));
                }
            });
    }

    async close(): Promise<void> {
        await this.writeChain;
    }
}

export function createRuntimeLogWriter(options: RuntimeLogWriterOptions): RuntimeLogWriter {
    return new RuntimeLogWriter(options);
}
