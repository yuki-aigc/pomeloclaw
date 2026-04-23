import { createServer, type IncomingMessage, type Server as HTTPServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { WebConfig } from '../../config.js';
import type {
    ChannelAdapter,
    ChannelAdapterRuntime,
    ChannelAttachment,
    ChannelInboundMessage,
    ChannelProactiveRequest,
    ChannelReplyRequest,
    GatewayDispatchResult,
} from '../gateway/types.js';
import { renderWebChatPage } from './ui.js';
import {
    WebSessionRegistry,
    resolveHelloIdentity,
    resolveMessageIdentity,
} from './api.js';
import {
    MAX_WEB_UPLOAD_FILES,
    MAX_WEB_UPLOAD_FILE_BYTES,
    MAX_WEB_REPLY_FILE_BYTES,
    buildAttachmentBasePath,
    buildContentDisposition,
    detectWebMediaType,
    guessMimeType,
    isPathInsideDir,
    resolvePathFromWorkspace,
    sanitizeFileName,
} from './file-utils.js';
import {
    listSkillFiles,
    listSkillMarkdownFiles,
    readSkillFile,
    readMemoryMarkdownFile,
    writeMemoryMarkdownFile,
    writeSkillFile,
} from './workspace-file-store.js';
import { listInstalledSkills } from '../../skills/manager.js';
import { parseMCPManagementAction, type MCPManager } from '../../mcp-manager.js';
import { collectRequestedWebSkills, resolveRequestedWebSkills } from './skill-selection.js';
import type {
    WebAttachmentPayload,
    WebAttachmentRecord,
    WebCancelPayload,
    WebClientEnvelope,
    WebConnectionState,
    WebHelloPayload,
    WebInboundAttachmentPayload,
    WebLogger,
    WebMessagePayload,
    WebServerEnvelope,
    WebTokenUsagePayload,
    WebUploadedAttachmentPayload,
    WebUploadRecord,
} from './types.js';

export interface WebChannelAdapterOptions {
    config: WebConfig;
    log: WebLogger;
    workspaceRoot: string;
    skillsRoot: string;
    mcpManager?: MCPManager;
    resolveTokenUsage?: (conversationId: string) => WebTokenUsagePayload | null;
    onCancelRequest?: (params: { conversationId: string; requestId?: string; connectionId: string }) => Promise<{
        ok: boolean;
        requestId?: string;
        alreadyCancelled?: boolean;
        reason?: string;
    }>;
}

export interface WebStreamRequest {
    inbound: ChannelInboundMessage;
    payload: WebServerEnvelope;
}

const ATTACHMENT_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_API_PATH = '/api/web/sessions';
const UPLOAD_API_PATH = '/api/web/uploads';
const SKILLS_API_PATH = '/api/web/skills';
const SKILLS_FILE_API_PATH = '/api/web/files/skills';
const MEMORY_FILE_API_PATH = '/api/web/files/memory';
const MCP_API_PATH = '/api/web/mcp';

function parseClientEnvelope(raw: RawData): WebClientEnvelope | null {
    let text = '';
    if (typeof raw === 'string') {
        text = raw;
    } else if (raw instanceof Buffer) {
        text = raw.toString('utf8');
    } else if (raw instanceof ArrayBuffer) {
        text = Buffer.from(raw).toString('utf8');
    } else if (Array.isArray(raw)) {
        text = Buffer.concat(raw).toString('utf8');
    } else if (ArrayBuffer.isView(raw)) {
        text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
    }

    if (!text.trim()) return null;

    try {
        const parsed = JSON.parse(text) as WebClientEnvelope;
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

function normalizePath(path?: string, fallback: string = '/ws/web'): string {
    const normalized = path?.trim() || fallback;
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function tryTrim(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

export class WebChannelAdapter implements ChannelAdapter {
    readonly channel = 'web';
    readonly capabilities = {
        supportsStreamingReply: true,
        supportsApprovalFlow: false,
        supportsAttachmentReply: true,
        supportsProactiveMessage: true,
    };

    private runtime: ChannelAdapterRuntime | null = null;
    private started = false;
    private server: HTTPServer | null = null;
    private wsServer: WebSocketServer | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;

    private readonly connections = new Map<string, WebConnectionState>();
    private readonly conversationIndex = new Map<string, Set<string>>();
    private readonly userIndex = new Map<string, Set<string>>();
    private readonly attachmentRegistry = new Map<string, WebAttachmentRecord>();
    private readonly uploadRegistry = new Map<string, WebUploadRecord>();
    private readonly sessionRegistry = new WebSessionRegistry();

    constructor(private readonly options: WebChannelAdapterOptions) {}

    private resolveTokenUsage(conversationId?: string): WebTokenUsagePayload | undefined {
        const normalized = conversationId?.trim();
        if (!normalized || !this.options.resolveTokenUsage) {
            return undefined;
        }
        return this.options.resolveTokenUsage(normalized) || undefined;
    }

    private withTokenUsage(payload: WebServerEnvelope, conversationId?: string): WebServerEnvelope {
        const tokenUsage = this.resolveTokenUsage(conversationId);
        if (!tokenUsage) {
            return payload;
        }
        return {
            ...payload,
            token_usage: tokenUsage,
            tokenUsage: tokenUsage,
        };
    }

    async start(runtime: ChannelAdapterRuntime): Promise<void> {
        if (this.started) return;

        this.runtime = runtime;
        const cfg = this.options.config;
        const wsPath = normalizePath(cfg.path, '/ws/web');
        const uiPath = normalizePath(cfg.uiPath, '/web');
        const server = createServer((req, res) => {
            void this.handleHttpRequest(req, res, uiPath);
        });
        const wsServer = new WebSocketServer({
            server,
            path: wsPath,
            maxPayload: cfg.maxPayloadBytes,
        });

        this.server = server;
        this.wsServer = wsServer;

        wsServer.on('connection', (socket, request) => {
            this.handleConnection(socket, request);
        });
        wsServer.on('error', (error) => {
            this.options.log.error('[WebAdapter] websocket server error:', error instanceof Error ? error.message : String(error));
        });
        server.on('error', (error) => {
            this.options.log.error('[WebAdapter] http server error:', error instanceof Error ? error.message : String(error));
        });

        await new Promise<void>((resolve, reject) => {
            server.listen(cfg.port, cfg.host, () => resolve());
            server.once('error', reject);
        });

        this.startHeartbeat();
        this.started = true;
        this.options.log.info(`[WebAdapter] UI ready at http://${cfg.host}:${cfg.port}${uiPath}`);
        this.options.log.info(`[WebAdapter] websocket ready at ws://${cfg.host}:${cfg.port}${wsPath}`);
    }

    async stop(): Promise<void> {
        if (!this.started) return;

        this.started = false;

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        for (const state of this.connections.values()) {
            try {
                state.socket.close(1001, 'server shutdown');
            } catch {
                // ignore close errors on shutdown
            }
        }

        if (this.wsServer) {
            const wsServer = this.wsServer;
            this.wsServer = null;
            await new Promise<void>((resolve) => {
                wsServer.close(() => resolve());
            });
        }

        if (this.server) {
            const server = this.server;
            this.server = null;
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        }

        this.connections.clear();
        this.conversationIndex.clear();
        this.userIndex.clear();
        this.attachmentRegistry.clear();
        this.uploadRegistry.clear();
        this.sessionRegistry.clear();
        this.runtime = null;
        this.options.log.info('[WebAdapter] stopped');
    }

    async sendReply(request: ChannelReplyRequest): Promise<void> {
        const targets = this.resolveReplyTargets(request.inbound);
        if (targets.size === 0) {
            throw new Error(`web reply target not found for conversation=${request.inbound.conversationId}`);
        }

        const attachments = await this.registerReplyAttachments(request.message.attachments || []);
        const payload: WebServerEnvelope = {
            type: 'reply',
            messageId: request.inbound.messageId,
            request_id: request.inbound.messageId,
            conversationId: request.inbound.conversationId,
            session_id: request.inbound.conversationId,
            text: request.message.text,
            title: request.message.title,
            useMarkdown: request.message.useMarkdown,
            attachments,
            metadata: request.message.metadata,
            timestamp: Date.now(),
        };

        this.broadcastToConnections(targets, this.withTokenUsage(payload, request.inbound.conversationId));
    }

    async sendStreamEvent(request: WebStreamRequest): Promise<void> {
        const targets = this.resolveReplyTargets(request.inbound);
        if (targets.size === 0) {
            throw new Error(`web stream target not found for conversation=${request.inbound.conversationId}`);
        }
        this.broadcastToConnections(targets, this.withTokenUsage(request.payload, request.inbound.conversationId));
    }

    async sendProactive(request: ChannelProactiveRequest): Promise<void> {
        const targets = this.resolveProactiveTargets(request.target);
        if (targets.size === 0) {
            throw new Error(`web proactive target not found: ${request.target}`);
        }

        const attachments = await this.registerReplyAttachments(request.message.attachments || []);
        const payload: WebServerEnvelope = {
            type: 'proactive',
            target: request.target,
            session_id: request.target,
            text: request.message.text,
            title: request.message.title,
            useMarkdown: request.message.useMarkdown,
            attachments,
            metadata: request.message.metadata,
            timestamp: Date.now(),
        };

        this.broadcastToConnections(targets, payload);
    }

    async handleInbound(message: ChannelInboundMessage): Promise<GatewayDispatchResult> {
        if (!this.started || !this.runtime) {
            throw new Error('Web adapter is not started');
        }
        return this.runtime.onInbound({
            ...message,
            channel: 'web',
        });
    }

    async registerReplyAttachments(paths: string[]): Promise<WebAttachmentPayload[]> {
        this.cleanupExpiredAttachments();
        const attachments: WebAttachmentPayload[] = [];
        const seen = new Set<string>();
        const workspaceTmpRoot = path.resolve(this.options.workspaceRoot, 'tmp');
        const uiPath = normalizePath(this.options.config.uiPath, '/web');
        const attachmentBasePath = buildAttachmentBasePath(uiPath);

        for (const rawPath of paths) {
            const trimmed = rawPath.trim();
            if (!trimmed) continue;

            let resolved = '';
            try {
                resolved = resolvePathFromWorkspace(this.options.workspaceRoot, trimmed);
            } catch (error) {
                this.options.log.warn(`[WebAdapter] attachment path resolve failed: ${String(error)}`);
                continue;
            }
            if (seen.has(resolved)) {
                continue;
            }
            seen.add(resolved);

            if (!isPathInsideDir(resolved, workspaceTmpRoot)) {
                this.options.log.warn(`[WebAdapter] skip attachment outside workspace/tmp: ${resolved}`);
                continue;
            }

            let stat;
            try {
                stat = await fsPromises.stat(resolved);
            } catch {
                this.options.log.warn(`[WebAdapter] attachment not found: ${resolved}`);
                continue;
            }
            if (!stat.isFile()) {
                this.options.log.warn(`[WebAdapter] skip non-file attachment: ${resolved}`);
                continue;
            }
            if (stat.size <= 0) {
                this.options.log.warn(`[WebAdapter] skip empty attachment: ${resolved}`);
                continue;
            }
            if (stat.size > MAX_WEB_REPLY_FILE_BYTES) {
                this.options.log.warn(`[WebAdapter] skip oversized attachment: ${resolved}`);
                continue;
            }

            const id = randomUUID().replace(/-/g, '');
            const name = path.basename(resolved);
            const record: WebAttachmentRecord = {
                id,
                name,
                path: resolved,
                url: `${attachmentBasePath}/${id}/${encodeURIComponent(name)}`,
                sizeBytes: stat.size,
                mimeType: guessMimeType(resolved),
                createdAt: Date.now(),
                expiresAt: Date.now() + ATTACHMENT_TTL_MS,
            };
            this.attachmentRegistry.set(id, record);
            attachments.push({
                id: record.id,
                name: record.name,
                url: record.url,
                sizeBytes: record.sizeBytes,
                mimeType: record.mimeType,
            });
        }

        return attachments;
    }

    private async handleHttpRequest(req: IncomingMessage, res: ServerResponse, uiPath: string): Promise<void> {
        const method = req.method || 'GET';
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const attachmentBasePath = buildAttachmentBasePath(uiPath);
        if (method === 'OPTIONS' && (
            url.pathname === SESSION_API_PATH
            || url.pathname === UPLOAD_API_PATH
            || url.pathname === SKILLS_API_PATH
            || url.pathname === SKILLS_FILE_API_PATH
            || url.pathname === MEMORY_FILE_API_PATH
            || url.pathname === MCP_API_PATH
        )) {
            this.writeApiCorsHeaders(res);
            res.writeHead(204);
            res.end();
            return;
        }
        if (method === 'GET' && url.pathname === '/healthz') {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('ok');
            return;
        }

        if (method === 'POST' && url.pathname === SESSION_API_PATH) {
            await this.handleCreateSessionRequest(req, res);
            return;
        }

        if (method === 'POST' && url.pathname === UPLOAD_API_PATH) {
            await this.handleUploadRequest(req, res);
            return;
        }

        if (method === 'GET' && url.pathname === SKILLS_API_PATH) {
            if (!this.ensureWorkspaceManageApiAuthorized(req, res)) {
                return;
            }
            await this.handleSkillsReadRequest(res);
            return;
        }

        if (url.pathname === SKILLS_FILE_API_PATH) {
            if (!this.ensureWorkspaceManageApiAuthorized(req, res)) {
                return;
            }
            if (method === 'GET') {
                await this.handleSkillFileReadRequest(url, res);
                return;
            }
            if (method === 'PUT') {
                await this.handleSkillFileWriteRequest(req, res);
                return;
            }
        }

        if (url.pathname === MEMORY_FILE_API_PATH) {
            if (!this.ensureWorkspaceManageApiAuthorized(req, res)) {
                return;
            }
            if (method === 'GET') {
                await this.handleMemoryFileReadRequest(url, res);
                return;
            }
            if (method === 'PUT') {
                await this.handleMemoryFileWriteRequest(req, res);
                return;
            }
        }

        if (url.pathname === MCP_API_PATH) {
            if (!this.ensureWorkspaceManageApiAuthorized(req, res)) {
                return;
            }
            if (method === 'GET') {
                await this.handleMCPReadRequest(res);
                return;
            }
            if (method === 'POST') {
                await this.handleMCPWriteRequest(req, res);
                return;
            }
        }

        if (method === 'GET' && (url.pathname === uiPath || (uiPath !== '/' && url.pathname === '/'))) {
            if (url.pathname === '/' && uiPath !== '/') {
                res.writeHead(302, { location: uiPath });
                res.end();
                return;
            }
            const html = renderWebChatPage(this.options.config);
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(html);
            return;
        }

        if (method === 'GET' && (url.pathname === attachmentBasePath || url.pathname.startsWith(`${attachmentBasePath}/`))) {
            await this.handleAttachmentRequest(url.pathname, res, attachmentBasePath);
            return;
        }

        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }

    private async handleAttachmentRequest(
        pathname: string,
        res: ServerResponse,
        attachmentBasePath: string,
    ): Promise<void> {
        this.cleanupExpiredAttachments();
        const attachmentId = decodeURIComponent(pathname.slice(attachmentBasePath.length + 1).split('/')[0] || '');
        if (!attachmentId) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Attachment Not Found');
            return;
        }

        const record = this.attachmentRegistry.get(attachmentId);
        if (!record || record.expiresAt <= Date.now()) {
            this.attachmentRegistry.delete(attachmentId);
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Attachment Not Found');
            return;
        }

        try {
            const stat = await fsPromises.stat(record.path);
            if (!stat.isFile()) {
                throw new Error('Attachment is not a file');
            }
            res.writeHead(200, {
                'content-type': record.mimeType,
                'content-length': String(stat.size),
                'content-disposition': buildContentDisposition(record.name),
                'cache-control': 'private, max-age=300',
                'x-content-type-options': 'nosniff',
            });
            await pipeline(createReadStream(record.path), res);
        } catch (error) {
            this.options.log.warn(`[WebAdapter] attachment send failed: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            }
            res.end('Attachment Not Found');
        }
    }

    private async handleCreateSessionRequest(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        try {
            const body = await this.readJsonBody(req);
            const userId = typeof body.user_id === 'string'
                ? body.user_id.trim()
                : typeof body.userId === 'string'
                    ? body.userId.trim()
                    : '';
            const nickName = typeof body.nick_name === 'string'
                ? body.nick_name.trim()
                : typeof body.nickName === 'string'
                    ? body.nickName.trim()
                    : '';
            const requestedSessionId = typeof body.session_id === 'string'
                ? body.session_id.trim()
                : typeof body.sessionId === 'string'
                    ? body.sessionId.trim()
                    : undefined;
            const sessionTitle = typeof body.session_title === 'string'
                ? body.session_title.trim()
                : typeof body.sessionTitle === 'string'
                    ? body.sessionTitle.trim()
                    : undefined;

            if (!userId) {
                this.writeApiCorsHeaders(res);
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: false,
                    error: {
                        code: 'bad_request',
                        message: 'user_id 不能为空',
                    },
                }));
                return;
            }

            const result = this.sessionRegistry.bind({
                requestedSessionId,
                userId,
                nickName: nickName || userId,
                sessionTitle,
            });
            if (!result.ok) {
                this.writeApiCorsHeaders(res);
                res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: false,
                    error: {
                        code: result.code,
                        message: result.reason,
                    },
                }));
                return;
            }

            this.writeApiCorsHeaders(res);
            res.writeHead(result.created ? 201 : 200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            const tokenUsage = this.resolveTokenUsage(result.session.sessionId);
            res.end(JSON.stringify({
                ok: true,
                session_id: result.session.sessionId,
                user_id: result.session.userId,
                nick_name: result.session.nickName,
                session_title: result.session.sessionTitle,
                created_at: result.session.createdAt,
                reused: !result.created,
                token_usage: tokenUsage,
                tokenUsage: tokenUsage,
            }));
        } catch (error) {
            this.writeApiCorsHeaders(res);
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                ok: false,
                error: {
                    code: 'bad_request',
                    message: error instanceof Error ? error.message : String(error),
                },
            }));
        }
    }

    private async handleUploadRequest(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        try {
            const parsed = await this.readUploadRequest(req);
            if (parsed.files.length === 0) {
                throw new Error('至少上传一个文件');
            }
            if (parsed.files.length > MAX_WEB_UPLOAD_FILES) {
                throw new Error(`单次最多上传 ${MAX_WEB_UPLOAD_FILES} 个文件`);
            }

            const uploads: WebUploadedAttachmentPayload[] = [];
            for (const file of parsed.files) {
                if (!file.name.trim()) {
                    throw new Error('上传文件名不能为空');
                }
                if (file.sizeBytes <= 0) {
                    throw new Error(`文件为空: ${file.name}`);
                }
                if (file.sizeBytes > MAX_WEB_UPLOAD_FILE_BYTES) {
                    throw new Error(`文件超过 ${Math.floor(MAX_WEB_UPLOAD_FILE_BYTES / 1024 / 1024)}MB 限制: ${file.name}`);
                }
                uploads.push(await this.registerInboundUpload({
                    userId: parsed.userId,
                    sessionId: parsed.sessionId,
                    name: file.name,
                    mimeType: file.mimeType,
                    buffer: file.buffer,
                }));
            }

            this.writeApiCorsHeaders(res);
            res.writeHead(201, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({
                ok: true,
                uploads,
            }));
        } catch (error) {
            this.writeApiCorsHeaders(res);
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                ok: false,
                error: {
                    code: 'bad_request',
                    message: error instanceof Error ? error.message : String(error),
                },
            }));
        }
    }

    private async handleSkillFileReadRequest(url: URL, res: ServerResponse): Promise<void> {
        try {
            const skill = tryTrim(url.searchParams.get('skill')) || tryTrim(url.searchParams.get('name'));
            if (!skill) {
                const skills = await listSkillMarkdownFiles(this.options.skillsRoot);
                this.writeApiJson(res, 200, {
                    ok: true,
                    skills: skills.map((item) => ({
                        skill: item.skillDir,
                        path: item.absPath,
                        sizeBytes: item.sizeBytes,
                        updatedAtMs: item.updatedAtMs,
                    })),
                });
                return;
            }

            const targetPath = tryTrim(url.searchParams.get('path')) || tryTrim(url.searchParams.get('file'));
            const tree = await listSkillFiles({
                skillsRoot: this.options.skillsRoot,
                skillDir: skill,
            });
            const file = await readSkillFile({
                skillsRoot: this.options.skillsRoot,
                skillDir: skill,
                relativePath: targetPath,
            });
            this.writeApiJson(res, 200, {
                ok: true,
                skill,
                skillRootPath: tree.skillRootPath,
                summary: {
                    fileCount: tree.fileCount,
                    directoryCount: tree.directoryCount,
                },
                tree: tree.tree,
                file: {
                    relativePath: file.relativePath,
                    absPath: file.absPath,
                    missing: !file.exists,
                    sizeBytes: file.sizeBytes,
                    updatedAtMs: file.updatedAtMs,
                    content: file.content,
                },
            });
        } catch (error) {
            this.writeApiError(
                res,
                400,
                'bad_request',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async handleSkillsReadRequest(res: ServerResponse): Promise<void> {
        try {
            const skills = await listInstalledSkills(this.options.skillsRoot);
            this.writeApiJson(res, 200, {
                ok: true,
                skills: skills.map((item) => ({
                    name: item.name,
                    description: item.description,
                    dirName: item.dirName,
                    path: item.absPath,
                    updatedAtMs: item.updatedAtMs,
                })),
            });
        } catch (error) {
            this.writeApiError(
                res,
                500,
                'internal_error',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async handleSkillFileWriteRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const body = await this.readJsonBody(req, 2 * 1024 * 1024);
            const skill = tryTrim(body.skill) || tryTrim(body.skill_dir) || tryTrim(body.name);
            const relativePath = tryTrim(body.path) || tryTrim(body.file);
            if (!skill) {
                this.writeApiError(res, 400, 'bad_request', 'skill 不能为空');
                return;
            }
            if (typeof body.content !== 'string') {
                this.writeApiError(res, 400, 'bad_request', 'content 必须是字符串');
                return;
            }

            const file = await writeSkillFile({
                skillsRoot: this.options.skillsRoot,
                skillDir: skill,
                relativePath,
                content: body.content,
            });
            const tree = await listSkillFiles({
                skillsRoot: this.options.skillsRoot,
                skillDir: skill,
            });
            this.writeApiJson(res, 200, {
                ok: true,
                skill,
                skillRootPath: tree.skillRootPath,
                summary: {
                    fileCount: tree.fileCount,
                    directoryCount: tree.directoryCount,
                },
                tree: tree.tree,
                file: {
                    relativePath: file.relativePath,
                    absPath: file.absPath,
                    missing: false,
                    sizeBytes: file.sizeBytes,
                    updatedAtMs: file.updatedAtMs,
                    content: file.content,
                },
            });
        } catch (error) {
            this.writeApiError(
                res,
                400,
                'bad_request',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async handleMemoryFileReadRequest(url: URL, res: ServerResponse): Promise<void> {
        try {
            const relPath = tryTrim(url.searchParams.get('path'));
            const file = await readMemoryMarkdownFile({
                workspaceRoot: this.options.workspaceRoot,
                relativePath: relPath,
            });
            this.writeApiJson(res, 200, {
                ok: true,
                file: {
                    path: file.relativePath,
                    absPath: file.absPath,
                    missing: !file.exists,
                    sizeBytes: file.sizeBytes,
                    updatedAtMs: file.updatedAtMs,
                    content: file.content,
                },
            });
        } catch (error) {
            this.writeApiError(
                res,
                400,
                'bad_request',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async handleMemoryFileWriteRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const body = await this.readJsonBody(req, 2 * 1024 * 1024);
            const relPath = tryTrim(body.path);
            if (typeof body.content !== 'string') {
                this.writeApiError(res, 400, 'bad_request', 'content 必须是字符串');
                return;
            }
            const file = await writeMemoryMarkdownFile({
                workspaceRoot: this.options.workspaceRoot,
                relativePath: relPath,
                content: body.content,
            });
            this.writeApiJson(res, 200, {
                ok: true,
                file: {
                    path: file.relativePath,
                    absPath: file.absPath,
                    missing: false,
                    sizeBytes: file.sizeBytes,
                    updatedAtMs: file.updatedAtMs,
                    content: file.content,
                },
            });
        } catch (error) {
            this.writeApiError(
                res,
                400,
                'bad_request',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async handleMCPReadRequest(res: ServerResponse): Promise<void> {
        if (!this.options.mcpManager) {
            this.writeApiError(res, 501, 'not_implemented', '当前服务未启用 MCP 管理');
            return;
        }

        this.writeApiJson(res, 200, {
            ok: true,
            mcp: this.options.mcpManager.getState(),
        });
    }

    private async handleMCPWriteRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!this.options.mcpManager) {
            this.writeApiError(res, 501, 'not_implemented', '当前服务未启用 MCP 管理');
            return;
        }

        try {
            const body = await this.readJsonBody(req, 2 * 1024 * 1024);
            const action = parseMCPManagementAction(body);
            const state = await this.options.mcpManager.execute(action);
            this.writeApiJson(res, 200, {
                ok: true,
                mcp: state,
            });
        } catch (error) {
            this.writeApiError(
                res,
                400,
                'bad_request',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async readUploadRequest(req: IncomingMessage): Promise<{
        userId?: string;
        sessionId?: string;
        files: Array<{ name: string; mimeType: string; sizeBytes: number; buffer: Buffer }>;
    }> {
        const contentType = (req.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('multipart/form-data')) {
            return this.readMultipartUploadBody(req);
        }

        const body = await this.readJsonBody(req, 32 * 1024 * 1024);
        const userId = tryTrim(body.user_id) || tryTrim(body.userId);
        const sessionId = tryTrim(body.session_id) || tryTrim(body.sessionId);
        const rawFiles = Array.isArray(body.files) ? body.files : [];
        const files: Array<{ name: string; mimeType: string; sizeBytes: number; buffer: Buffer }> = [];

        for (const item of rawFiles) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const file = item as Record<string, unknown>;
            const fileName = tryTrim(file.name) || 'upload.bin';
            const mimeType = tryTrim(file.mime_type) || tryTrim(file.mimeType) || guessMimeType(fileName);
            const base64 = tryTrim(file.content_base64) || tryTrim(file.contentBase64);
            if (!base64) {
                throw new Error(`文件缺少 content_base64: ${fileName}`);
            }
            const buffer = Buffer.from(base64, 'base64');
            if (buffer.length === 0) {
                throw new Error(`文件内容为空或 base64 非法: ${fileName}`);
            }
            files.push({
                name: fileName,
                mimeType,
                sizeBytes: buffer.length,
                buffer,
            });
        }

        return { userId, sessionId, files };
    }

    private async readMultipartUploadBody(req: IncomingMessage): Promise<{
        userId?: string;
        sessionId?: string;
        files: Array<{ name: string; mimeType: string; sizeBytes: number; buffer: Buffer }>;
    }> {
        const url = new URL(req.url || UPLOAD_API_PATH, `http://${req.headers.host || 'localhost'}`);
        const request = new Request(url, {
            method: req.method || 'POST',
            headers: req.headers as Record<string, string | string[]>,
            body: Readable.toWeb(req) as ReadableStream,
            duplex: 'half',
        });
        const formData = await request.formData();
        const userId = tryTrim(formData.get('user_id')) || tryTrim(formData.get('userId'));
        const sessionId = tryTrim(formData.get('session_id')) || tryTrim(formData.get('sessionId'));
        const files: Array<{ name: string; mimeType: string; sizeBytes: number; buffer: Buffer }> = [];

        for (const [key, value] of formData.entries()) {
            if (!(key === 'file' || key === 'files')) {
                continue;
            }
            if (!(value instanceof File)) {
                continue;
            }
            const arrayBuffer = await value.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            files.push({
                name: value.name || 'upload.bin',
                mimeType: value.type || guessMimeType(value.name || 'upload.bin'),
                sizeBytes: buffer.length,
                buffer,
            });
        }

        return { userId, sessionId, files };
    }

    private ensureWorkspaceManageApiAuthorized(req: IncomingMessage, res: ServerResponse): boolean {
        const expected = this.options.config.authToken?.trim();
        if (!expected) {
            return true;
        }

        const authorization = this.readHeaderToken(req.headers.authorization);
        if (authorization) {
            const bearer = authorization.match(/^Bearer\s+(.+)$/i);
            const token = (bearer?.[1] || authorization).trim();
            if (token === expected) {
                return true;
            }
        }

        const customToken = this.readHeaderToken(req.headers['x-web-auth-token'])
            || this.readHeaderToken(req.headers['x-web-token']);
        if (customToken?.trim() === expected) {
            return true;
        }

        this.writeApiError(res, 401, 'unauthorized', '缺少或无效的授权 token');
        return false;
    }

    private readHeaderToken(value: string | string[] | undefined): string | undefined {
        if (typeof value === 'string') {
            return value.trim() || undefined;
        }
        if (Array.isArray(value)) {
            const first = value.find((item) => typeof item === 'string' && item.trim());
            return first?.trim() || undefined;
        }
        return undefined;
    }

    private async registerInboundUpload(params: {
        userId?: string;
        sessionId?: string;
        name: string;
        mimeType?: string;
        buffer: Buffer;
    }): Promise<WebUploadedAttachmentPayload> {
        this.cleanupExpiredUploads();
        const uploadId = `upl_${randomUUID().replace(/-/g, '')}`;
        const safeName = sanitizeFileName(params.name);
        const uploadRoot = path.resolve(this.options.workspaceRoot, 'tmp', 'web-uploads');
        const datedDir = new Date().toISOString().slice(0, 10);
        const targetDir = path.join(uploadRoot, datedDir);
        await fsPromises.mkdir(targetDir, { recursive: true });

        const targetPath = path.join(targetDir, `${uploadId}-${safeName}`);
        await fsPromises.writeFile(targetPath, params.buffer);

        const mimeType = (params.mimeType || guessMimeType(safeName)).trim() || guessMimeType(safeName);
        const mediaType = detectWebMediaType(safeName, mimeType);
        const record: WebUploadRecord = {
            id: uploadId,
            name: safeName,
            path: targetPath,
            sizeBytes: params.buffer.length,
            mimeType,
            mediaType,
            createdAt: Date.now(),
            expiresAt: Date.now() + ATTACHMENT_TTL_MS,
            userId: params.userId?.trim() || undefined,
            sessionId: params.sessionId?.trim() || undefined,
        };
        this.uploadRegistry.set(uploadId, record);
        return {
            upload_id: record.id,
            uploadId: record.id,
            name: record.name,
            sizeBytes: record.sizeBytes,
            mimeType: record.mimeType,
            mime_type: record.mimeType,
            mediaType: record.mediaType,
            media_type: record.mediaType,
        };
    }

    private resolveInboundAttachments(
        attachments: WebInboundAttachmentPayload[] | undefined,
        identity: { userId: string; sessionId: string },
    ): ChannelAttachment[] {
        this.cleanupExpiredUploads();
        if (!Array.isArray(attachments) || attachments.length === 0) {
            return [];
        }

        const resolved: ChannelAttachment[] = [];
        const seen = new Set<string>();
        for (const item of attachments) {
            const uploadId = tryTrim(item?.upload_id) || tryTrim(item?.uploadId);
            if (!uploadId) {
                throw new Error('attachments[].upload_id 不能为空');
            }
            if (seen.has(uploadId)) {
                continue;
            }
            seen.add(uploadId);

            const record = this.uploadRegistry.get(uploadId);
            if (!record || record.expiresAt <= Date.now()) {
                this.uploadRegistry.delete(uploadId);
                throw new Error(`附件不存在或已过期: ${uploadId}`);
            }
            if (record.userId && record.userId !== identity.userId) {
                throw new Error(`附件 ${uploadId} 不属于当前 user_id`);
            }
            if (record.sessionId && record.sessionId !== identity.sessionId) {
                throw new Error(`附件 ${uploadId} 不属于当前 session_id`);
            }

            resolved.push({
                name: record.name,
                path: record.path,
                mimeType: record.mimeType,
                metadata: {
                    uploadId: record.id,
                    mediaType: record.mediaType,
                    sizeBytes: record.sizeBytes,
                    source: 'web_upload',
                },
            });
        }

        return resolved;
    }

    private hasAuthToken(): boolean {
        return Boolean(this.options.config.authToken?.trim());
    }

    private handleConnection(socket: WebSocket, request: IncomingMessage): void {
        const state: WebConnectionState = {
            connectionId: randomUUID(),
            socket,
            request,
            isAlive: true,
            authenticated: !this.hasAuthToken(),
        };

        this.connections.set(state.connectionId, state);

        socket.on('pong', () => {
            state.isAlive = true;
        });

        socket.on('message', (raw) => {
            void this.handleSocketMessage(state, raw);
        });

        socket.on('close', () => {
            this.handleDisconnect(state);
        });

        socket.on('error', (error) => {
            this.options.log.warn(`[WebAdapter] socket error(${state.connectionId}):`, error instanceof Error ? error.message : String(error));
        });

        this.sendToConnection(state, {
            type: 'hello_required',
            connectionId: state.connectionId,
            connection_id: state.connectionId,
            authenticated: state.authenticated,
            serverTime: Date.now(),
        });

        this.options.log.info(`[WebAdapter] connection opened: ${state.connectionId}`);
    }

    private async handleSocketMessage(state: WebConnectionState, raw: RawData): Promise<void> {
        const envelope = parseClientEnvelope(raw);
        state.isAlive = true;

        if (!envelope) {
            this.sendToConnection(state, {
                type: 'error',
                code: 'bad_json',
                message: '消息不是合法 JSON 或缺少 type 字段',
            });
            return;
        }

        if (envelope.type === 'ping') {
            this.sendToConnection(state, {
                type: 'pong',
                timestamp: Date.now(),
            });
            return;
        }

        if (envelope.type === 'hello') {
            this.handleHello(state, envelope);
            return;
        }

        if (this.hasAuthToken() && !state.authenticated) {
            this.sendToConnection(state, {
                type: 'error',
                code: 'unauthorized',
                message: '请先发送 hello 完成认证',
            });
            try {
                state.socket.close(4401, 'unauthorized');
            } catch {
                // ignore close errors
            }
            return;
        }

        if (envelope.type === 'message') {
            await this.handleClientMessage(state, envelope);
            return;
        }

        if (envelope.type === 'cancel') {
            await this.handleCancelMessage(state, envelope);
            return;
        }

        this.sendToConnection(state, {
            type: 'error',
            code: 'unsupported_type',
            message: `不支持的消息类型: ${(envelope as { type?: string }).type || 'unknown'}`,
        });
    }

    private handleHello(state: WebConnectionState, payload: WebHelloPayload): void {
        const expectedToken = this.options.config.authToken?.trim();
        const providedToken = tryTrim(payload.token);

        if (expectedToken && providedToken !== expectedToken) {
            this.sendToConnection(state, {
                type: 'error',
                code: 'auth_failed',
                message: '认证失败',
            });
            try {
                state.socket.close(4403, 'auth failed');
            } catch {
                // ignore close errors
            }
            return;
        }

        const previousConversation = state.conversationId;
        const previousUser = state.userId;

        const identity = resolveHelloIdentity(payload, state);
        const sessionResult = this.sessionRegistry.bind({
            requestedSessionId: identity.requestedSessionId,
            userId: identity.userId,
            nickName: identity.nickName,
            sessionTitle: identity.sessionTitle,
        });
        if (!sessionResult.ok) {
            this.sendToConnection(state, {
                type: 'error',
                code: sessionResult.code,
                message: sessionResult.reason,
            });
            return;
        }

        state.authenticated = true;
        state.clientId = identity.clientId || state.clientId;
        state.userId = identity.userId;
        state.userName = identity.nickName;
        state.conversationId = sessionResult.session.sessionId;
        state.conversationTitle = sessionResult.session.sessionTitle;
        state.isDirect = identity.isDirect;

        this.reindexConnection(state, previousConversation, previousUser);

        this.sendToConnection(state, this.withTokenUsage({
            type: 'hello_ack',
            connectionId: state.connectionId,
            connection_id: state.connectionId,
            authenticated: true,
            client_id: state.clientId,
            clientId: state.clientId,
            user_id: state.userId,
            userId: state.userId,
            nick_name: state.userName,
            userName: state.userName,
            session_id: state.conversationId,
            sessionId: state.conversationId,
            session_title: state.conversationTitle,
            conversationTitle: state.conversationTitle,
            api_path: SESSION_API_PATH,
            upload_api_path: UPLOAD_API_PATH,
            serverTime: Date.now(),
        }, state.conversationId));
    }

    private async handleClientMessage(state: WebConnectionState, payload: WebMessagePayload): Promise<void> {
        if (!this.runtime) {
            throw new Error('Web adapter runtime is not ready');
        }

        const text = payload.text?.trim() || '';
        const requestedSkills = collectRequestedWebSkills(payload);
        const hasAttachments = Array.isArray(payload.attachments) && payload.attachments.length > 0;
        if (!text && !hasAttachments) {
            this.sendToConnection(state, {
                type: 'error',
                code: 'empty_text',
                message: 'message.text 不能为空；如果只发附件，请同时传 attachments',
            });
            return;
        }

        const previousConversation = state.conversationId;
        const previousUser = state.userId;
        const identity = resolveMessageIdentity(payload, state);
        const sessionResult = this.sessionRegistry.bind({
            requestedSessionId: identity.requestedSessionId,
            userId: identity.userId,
            nickName: identity.nickName,
            sessionTitle: identity.sessionTitle,
        });
        if (!sessionResult.ok) {
            this.sendToConnection(state, this.withTokenUsage({
                type: 'dispatch_ack',
                messageId: identity.messageId,
                message_id: identity.messageId,
                request_id: identity.messageId,
                status: 'error',
                reason: sessionResult.reason,
                session_id: identity.requestedSessionId,
                sessionId: identity.requestedSessionId,
                timestamp: Date.now(),
            }, identity.requestedSessionId));
            return;
        }

        state.conversationId = sessionResult.session.sessionId;
        state.conversationTitle = sessionResult.session.sessionTitle;
        state.userId = identity.userId;
        state.userName = identity.nickName;
        state.isDirect = identity.isDirect;
        this.reindexConnection(state, previousConversation, previousUser);

        let selectedSkills: string[] = [];
        if (requestedSkills.length > 0) {
            const availableSkills = await listInstalledSkills(this.options.skillsRoot);
            const resolvedSkills = resolveRequestedWebSkills(requestedSkills, availableSkills);
            if (resolvedSkills.unknown.length > 0) {
                this.sendToConnection(state, this.withTokenUsage({
                    type: 'dispatch_ack',
                    messageId: identity.messageId,
                    message_id: identity.messageId,
                    request_id: identity.messageId,
                    status: 'error',
                    reason: `未找到以下技能: ${resolvedSkills.unknown.join(', ')}`,
                    session_id: state.conversationId,
                    sessionId: state.conversationId,
                    timestamp: Date.now(),
                }, state.conversationId));
                return;
            }
            selectedSkills = resolvedSkills.selected;
        }

        let inboundAttachments: ChannelAttachment[] = [];
        try {
            inboundAttachments = this.resolveInboundAttachments(payload.attachments, {
                userId: state.userId || identity.userId,
                sessionId: state.conversationId,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.sendToConnection(state, this.withTokenUsage({
                type: 'dispatch_ack',
                messageId: identity.messageId,
                message_id: identity.messageId,
                request_id: identity.messageId,
                status: 'error',
                reason,
                session_id: state.conversationId,
                sessionId: state.conversationId,
                timestamp: Date.now(),
            }, state.conversationId));
            return;
        }
        const inbound: ChannelInboundMessage = {
            channel: 'web',
            messageId: identity.messageId,
            idempotencyKey: identity.idempotencyKey,
            timestamp: identity.timestamp,
            conversationId: state.conversationId,
            conversationTitle: state.conversationTitle,
            isDirect: state.isDirect ?? true,
            senderId: state.userId || `web-user-${state.connectionId}`,
            senderName: state.userName || 'Web User',
            text,
            messageType: inboundAttachments.length > 0 ? (text ? 'mixed' : 'attachment') : 'text',
            attachments: inboundAttachments,
            workspaceRoot: this.options.workspaceRoot,
            metadata: {
                webConnectionId: state.connectionId,
                webClientId: state.clientId,
                webUserId: state.userId,
                webSessionId: state.conversationId,
                webAttachmentCount: inboundAttachments.length,
                webSelectedSkills: selectedSkills,
                webUserAgent: state.request.headers['user-agent'] || '',
                webOrigin: state.request.headers.origin || '',
                ...(payload.metadata || {}),
            },
            raw: payload,
        };

        let dispatchResult: GatewayDispatchResult;
        try {
            dispatchResult = await this.runtime.onInbound(inbound);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.sendToConnection(state, this.withTokenUsage({
                type: 'dispatch_ack',
                messageId: identity.messageId,
                message_id: identity.messageId,
                request_id: identity.messageId,
                status: 'error',
                reason,
                session_id: state.conversationId,
                sessionId: state.conversationId,
                timestamp: Date.now(),
            }, state.conversationId));
            this.options.log.error('[WebAdapter] dispatch failed(' + state.connectionId + '): ' + reason);
            return;
        }

        this.sendToConnection(state, this.withTokenUsage({
            type: 'dispatch_ack',
            messageId: identity.messageId,
            message_id: identity.messageId,
            request_id: identity.messageId,
            status: dispatchResult.status,
            reason: dispatchResult.reason,
            session_id: state.conversationId,
            sessionId: state.conversationId,
            timestamp: Date.now(),
        }, state.conversationId));
    }

    private async handleCancelMessage(state: WebConnectionState, payload: WebCancelPayload): Promise<void> {
        const conversationId = tryTrim(payload.session_id)
            || tryTrim(payload.sessionId)
            || tryTrim(payload.conversationId)
            || state.conversationId;
        const requestId = tryTrim(payload.request_id)
            || tryTrim(payload.requestId)
            || tryTrim(payload.message_id)
            || tryTrim(payload.messageId);

        if (!conversationId) {
            this.sendToConnection(state, {
                type: 'cancel_ack',
                status: 'error',
                reason: '缺少 session_id，无法定位要中断的会话',
                timestamp: Date.now(),
            });
            return;
        }

        if (!this.options.onCancelRequest) {
            this.sendToConnection(state, this.withTokenUsage({
                type: 'cancel_ack',
                status: 'unsupported',
                session_id: conversationId,
                sessionId: conversationId,
                request_id: requestId,
                requestId: requestId,
                reason: '服务端未启用会话中断能力',
                timestamp: Date.now(),
            }, conversationId));
            return;
        }

        try {
            const result = await this.options.onCancelRequest({
                conversationId,
                requestId,
                connectionId: state.connectionId,
            });

            this.sendToConnection(state, this.withTokenUsage({
                type: 'cancel_ack',
                status: result.ok ? (result.alreadyCancelled ? 'already_cancelled' : 'accepted') : 'not_found',
                session_id: conversationId,
                sessionId: conversationId,
                request_id: result.requestId || requestId,
                requestId: result.requestId || requestId,
                reason: result.reason,
                timestamp: Date.now(),
            }, conversationId));
        } catch (error) {
            this.sendToConnection(state, this.withTokenUsage({
                type: 'cancel_ack',
                status: 'error',
                session_id: conversationId,
                sessionId: conversationId,
                request_id: requestId,
                requestId: requestId,
                reason: error instanceof Error ? error.message : String(error),
                timestamp: Date.now(),
            }, conversationId));
        }
    }

    private handleDisconnect(state: WebConnectionState): void {
        this.connections.delete(state.connectionId);
        this.removeFromIndex(this.conversationIndex, state.conversationId, state.connectionId);
        this.removeFromIndex(this.userIndex, state.userId, state.connectionId);
        this.options.log.info(`[WebAdapter] connection closed: ${state.connectionId}`);
    }

    private reindexConnection(state: WebConnectionState, previousConversation?: string, previousUser?: string): void {
        this.removeFromIndex(this.conversationIndex, previousConversation, state.connectionId);
        this.removeFromIndex(this.userIndex, previousUser, state.connectionId);

        this.addToIndex(this.conversationIndex, state.conversationId, state.connectionId);
        this.addToIndex(this.userIndex, state.userId, state.connectionId);
    }

    private addToIndex(index: Map<string, Set<string>>, key: string | undefined, connectionId: string): void {
        const normalized = key?.trim();
        if (!normalized) return;
        const bucket = index.get(normalized) || new Set<string>();
        bucket.add(connectionId);
        index.set(normalized, bucket);
    }

    private removeFromIndex(index: Map<string, Set<string>>, key: string | undefined, connectionId: string): void {
        const normalized = key?.trim();
        if (!normalized) return;
        const bucket = index.get(normalized);
        if (!bucket) return;
        bucket.delete(connectionId);
        if (bucket.size === 0) {
            index.delete(normalized);
        }
    }

    private resolveReplyTargets(inbound: ChannelInboundMessage): Set<string> {
        const targets = new Set<string>();
        const metadata = inbound.metadata as Record<string, unknown> | undefined;
        const connectionId = tryTrim(metadata?.webConnectionId);
        if (connectionId && this.connections.has(connectionId)) {
            targets.add(connectionId);
        }

        if (targets.size === 0) {
            const conversationTargets = this.conversationIndex.get(inbound.conversationId);
            if (conversationTargets) {
                for (const id of conversationTargets) {
                    targets.add(id);
                }
            }
        }

        if (targets.size === 0) {
            const userTargets = this.userIndex.get(inbound.senderId);
            if (userTargets) {
                for (const id of userTargets) {
                    targets.add(id);
                }
            }
        }

        return targets;
    }

    private resolveProactiveTargets(target: string): Set<string> {
        const normalized = target.trim();
        if (!normalized) return new Set();

        const directMatch = this.connections.get(normalized);
        if (directMatch) {
            return new Set([directMatch.connectionId]);
        }

        const separatorIdx = normalized.indexOf(':');
        const hasPrefix = separatorIdx > 0;
        const prefix = hasPrefix ? normalized.slice(0, separatorIdx).toLowerCase() : '';
        const key = hasPrefix ? normalized.slice(separatorIdx + 1).trim() : normalized;

        if (!key) return new Set();
        if (prefix === 'connection') {
            return this.connections.has(key) ? new Set([key]) : new Set();
        }
        if (prefix === 'user') {
            return new Set(this.userIndex.get(key) || []);
        }
        if (prefix === 'conversation') {
            return new Set(this.conversationIndex.get(key) || []);
        }

        return new Set(this.conversationIndex.get(normalized) || []);
    }

    private broadcastToConnections(connectionIds: Set<string>, payload: WebServerEnvelope): void {
        let delivered = 0;
        for (const connectionId of connectionIds) {
            const state = this.connections.get(connectionId);
            if (!state) continue;
            if (this.sendToConnection(state, payload)) {
                delivered += 1;
            }
        }
        if (delivered === 0) {
            throw new Error('没有可用的在线连接');
        }
    }

    private sendToConnection(state: WebConnectionState, payload: WebServerEnvelope): boolean {
        if (state.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            state.socket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            this.options.log.warn(
                `[WebAdapter] send failed(${state.connectionId}):`,
                error instanceof Error ? error.message : String(error),
            );
            return false;
        }
    }

    private startHeartbeat(): void {
        const intervalMs = this.options.config.pingIntervalMs ?? 30000;
        if (intervalMs <= 0) return;

        this.heartbeatTimer = setInterval(() => {
            for (const state of this.connections.values()) {
                if (!state.isAlive) {
                    try {
                        state.socket.terminate();
                    } catch {
                        // ignore terminate errors
                    }
                    continue;
                }
                state.isAlive = false;
                try {
                    state.socket.ping();
                } catch {
                    // ignore ping errors
                }
            }
        }, intervalMs);

        this.heartbeatTimer.unref?.();
    }

    private cleanupExpiredAttachments(now: number = Date.now()): void {
        for (const [id, record] of this.attachmentRegistry.entries()) {
            if (record.expiresAt <= now) {
                this.attachmentRegistry.delete(id);
            }
        }
    }

    private cleanupExpiredUploads(now: number = Date.now()): void {
        for (const [id, record] of this.uploadRegistry.entries()) {
            if (record.expiresAt <= now) {
                this.uploadRegistry.delete(id);
            }
        }
    }

    private async readJsonBody(req: IncomingMessage, maxBytes: number = 64 * 1024): Promise<Record<string, unknown>> {
        const chunks: Buffer[] = [];
        let currentSize = 0;
        for await (const chunk of req) {
            const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            chunks.push(buffer);
            currentSize += buffer.length;
            if (currentSize > maxBytes) {
                throw new Error('请求体过大');
            }
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('请求体必须是 JSON 对象');
        }
        return parsed as Record<string, unknown>;
    }

    private writeApiCorsHeaders(res: ServerResponse): void {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type, authorization, x-web-auth-token, x-web-token');
    }

    private writeApiJson(res: ServerResponse, status: number, payload: unknown): void {
        this.writeApiCorsHeaders(res);
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        });
        res.end(JSON.stringify(payload));
    }

    private writeApiError(
        res: ServerResponse,
        status: number,
        code: string,
        message: string,
    ): void {
        this.writeApiJson(res, status, {
            ok: false,
            error: {
                code,
                message,
            },
        });
    }
}

export function createWebChannelAdapter(options: WebChannelAdapterOptions): WebChannelAdapter {
    return new WebChannelAdapter(options);
}
