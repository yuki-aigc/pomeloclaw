import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type { MCPConfig, RawConfigFile } from './types.js';

function isNotFoundError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

function detectIndent(text: string): number {
    const match = text.match(/^[ \t]+(?=")/m);
    if (!match) {
        return 4;
    }
    return match[0].includes('\t') ? 4 : match[0].length;
}

async function atomicWriteUtf8(absPath: string, content: string): Promise<void> {
    await fsPromises.mkdir(path.dirname(absPath), { recursive: true });
    const tempPath = path.join(path.dirname(absPath), `.${path.basename(absPath)}.${process.pid}.${randomUUID()}.tmp`);
    await fsPromises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
        await fsPromises.rename(tempPath, absPath);
    } finally {
        await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

export interface ConfigFileSnapshot {
    exists: boolean;
    content: string;
}

export async function readConfigFileSnapshot(configPath: string): Promise<ConfigFileSnapshot> {
    try {
        const content = await fsPromises.readFile(configPath, 'utf8');
        return {
            exists: true,
            content,
        };
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                exists: false,
                content: '',
            };
        }
        throw error;
    }
}

export async function restoreConfigFileSnapshot(configPath: string, snapshot: ConfigFileSnapshot): Promise<void> {
    if (!snapshot.exists) {
        await fsPromises.rm(configPath, { force: true }).catch(() => undefined);
        return;
    }
    await atomicWriteUtf8(configPath, snapshot.content);
}

export async function writeMCPConfigSection(configPath: string, mcp: MCPConfig): Promise<void> {
    const snapshot = await readConfigFileSnapshot(configPath);
    let fileConfig: RawConfigFile = {};
    let indent = 4;

    if (snapshot.exists) {
        const trimmed = snapshot.content.trim();
        if (trimmed) {
            try {
                fileConfig = JSON.parse(snapshot.content) as RawConfigFile;
            } catch (error) {
                throw new Error(`config.json 不是合法 JSON，无法写入 MCP 配置: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        indent = detectIndent(snapshot.content);
    }

    const nextConfig: RawConfigFile = {
        ...fileConfig,
        mcp: structuredClone(mcp),
    };

    await atomicWriteUtf8(configPath, `${JSON.stringify(nextConfig, null, indent)}\n`);
}
