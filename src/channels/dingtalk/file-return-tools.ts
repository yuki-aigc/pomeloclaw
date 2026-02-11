import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getDingTalkConversationContext, queueDingTalkReplyFile } from './context.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function isPathInsideDir(filePath: string, dirPath: string): boolean {
    const normalizedDir = path.resolve(dirPath);
    const normalizedFile = path.resolve(filePath);
    return normalizedFile === normalizedDir || normalizedFile.startsWith(`${normalizedDir}${path.sep}`);
}

function resolvePathFromWorkspace(workspaceRoot: string, rawPath: string): string {
    const candidate = rawPath.trim();
    if (!candidate) {
        throw new Error('path 不能为空');
    }
    if (path.isAbsolute(candidate)) {
        return path.resolve(candidate);
    }
    if (candidate.startsWith('workspace/')) {
        return path.resolve(process.cwd(), candidate);
    }
    return path.resolve(workspaceRoot, candidate);
}

function sanitizeFileName(fileName: string): string {
    return fileName
        .trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 120) || `reply-${Date.now()}.txt`;
}

export function createDingTalkFileReturnTools(workspaceRoot: string) {
    const workspaceTmpRoot = path.resolve(workspaceRoot, 'tmp');

    const dingtalkWriteTmpFile = tool(
        async ({ fileName, content }: { fileName: string; content: string }) => {
            const context = getDingTalkConversationContext();
            if (!context) {
                return '❌ 当前不是 DingTalk 会话，无法使用 dingtalk_write_tmp_file。';
            }
            const safeName = sanitizeFileName(fileName);
            const targetPath = path.resolve(workspaceTmpRoot, safeName);
            if (!isPathInsideDir(targetPath, workspaceTmpRoot)) {
                return '❌ 文件路径非法，只允许写入 workspace/tmp。';
            }

            await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
            await fsPromises.writeFile(targetPath, content, 'utf8');

            const stat = await fsPromises.stat(targetPath);
            if (stat.size <= 0) {
                return `⚠️ 文件写入成功但为空: ${targetPath}`;
            }
            if (stat.size > MAX_FILE_BYTES) {
                return `⚠️ 文件已写入但超过 10MB，不能回传: ${targetPath}`;
            }
            queueDingTalkReplyFile(targetPath);
            return `✅ 文件已写入并登记回传: ${targetPath}`;
        },
        {
            name: 'dingtalk_write_tmp_file',
            description: '将文本内容写入 workspace/tmp 下文件并登记为待回传附件（仅 DingTalk 会话可用）。',
            schema: z.object({
                fileName: z.string().describe('文件名（例如 report.md 或 result.json），仅会写入 workspace/tmp'),
                content: z.string().describe('文件内容'),
            }),
        }
    );

    const dingtalkSendFile = tool(
        async ({ path: rawPath }: { path: string }) => {
            const context = getDingTalkConversationContext();
            if (!context) {
                return '❌ 当前不是 DingTalk 会话，无法使用 dingtalk_send_file。';
            }
            const resolved = resolvePathFromWorkspace(workspaceRoot, rawPath);
            if (!isPathInsideDir(resolved, workspaceTmpRoot)) {
                return `❌ 仅允许回传 workspace/tmp 下文件。当前路径: ${resolved}`;
            }

            let stat;
            try {
                stat = await fsPromises.stat(resolved);
            } catch {
                return `❌ 文件不存在: ${resolved}`;
            }
            if (!stat.isFile()) {
                return `❌ 目标不是文件: ${resolved}`;
            }
            if (stat.size <= 0) {
                return `❌ 文件为空: ${resolved}`;
            }
            if (stat.size > MAX_FILE_BYTES) {
                return `❌ 文件超过 10MB 限制: ${resolved}`;
            }

            queueDingTalkReplyFile(resolved);
            return `✅ 已登记回传文件: ${resolved}`;
        },
        {
            name: 'dingtalk_send_file',
            description: '登记回传附件。只接受 workspace/tmp 下且 <=10MB 的文件（仅 DingTalk 会话可用）。',
            schema: z.object({
                path: z.string().describe('待回传文件路径（建议使用 workspace/tmp/...）'),
            }),
        }
    );

    return [dingtalkWriteTmpFile, dingtalkSendFile];
}
