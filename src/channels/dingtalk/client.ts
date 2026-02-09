/**
 * DingTalk API Client
 * Handles authentication and message sending
 */

import axios from 'axios';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { readFile as readFileAsync, stat as statFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DingTalkConfig } from '../../config.js';
import type {
    TokenInfo,
    SendMessageOptions,
    SessionWebhookBody,
    Logger,
    AICardInstance,
    AICardStreamingRequest,
} from './types.js';
import { AICardStatus } from './types.js';

// Access Token cache
let accessToken: string | null = null;
let accessTokenExpiry = 0;

// DingTalk API base URL
const DINGTALK_API = 'https://api.dingtalk.com';
const DINGTALK_LEGACY_API = 'https://oapi.dingtalk.com';
const MAX_DINGTALK_FILE_BYTES = 10 * 1024 * 1024;

// AI Card instance cache
const aiCardInstances = new Map<string, AICardInstance>();
const activeCardsByTarget = new Map<string, string>();
const CARD_CACHE_TTL = 60 * 60 * 1000;

type MediaFile = { path: string; mimeType: string };
type UploadMediaResponse = {
    errcode?: number;
    errmsg?: string;
    media_id?: string;
};

function getTargetKey(conversationId: string, isDirect: boolean, userId?: string): string {
    return isDirect ? (userId || conversationId) : conversationId;
}

export function cleanupCardCache(): void {
    const now = Date.now();
    for (const [cardInstanceId, instance] of aiCardInstances.entries()) {
        if (isCardFinished(instance) && now - instance.lastUpdated > CARD_CACHE_TTL) {
            aiCardInstances.delete(cardInstanceId);
            if (instance.targetKey && activeCardsByTarget.get(instance.targetKey) === cardInstanceId) {
                activeCardsByTarget.delete(instance.targetKey);
            }
        }
    }
}

export function getActiveAICard(targetKey: string): AICardInstance | undefined {
    cleanupCardCache();
    const cardId = activeCardsByTarget.get(targetKey);
    if (!cardId) return undefined;
    const card = aiCardInstances.get(cardId);
    if (!card) {
        activeCardsByTarget.delete(targetKey);
        return undefined;
    }
    if (isCardFinished(card)) {
        activeCardsByTarget.delete(targetKey);
        return undefined;
    }
    return card;
}

export async function downloadMedia(
    config: DingTalkConfig,
    downloadCode: string,
    log?: Logger
): Promise<MediaFile | null> {
    if (!config.robotCode) {
        log?.error?.('[DingTalk] downloadMedia requires robotCode to be configured.');
        return null;
    }
    try {
        const token = await getAccessToken(config, log);
        const response = await axios.post<{ downloadUrl?: string }>(
            `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
            { downloadCode, robotCode: config.robotCode },
            { headers: { 'x-acs-dingtalk-access-token': token } }
        );
        const downloadUrl = response.data?.downloadUrl;
        if (!downloadUrl) return null;
        const mediaResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
        const contentType = mediaResponse.headers['content-type'] || 'application/octet-stream';
        const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
        const tempPath = path.join(os.tmpdir(), `dingtalk_${Date.now()}.${ext}`);
        fs.writeFileSync(tempPath, Buffer.from(mediaResponse.data as ArrayBuffer));
        return { path: tempPath, mimeType: contentType };
    } catch (err) {
        log?.error?.(`[DingTalk] Failed to download media: ${String(err)}`);
        return null;
    }
}

function escapeMultipartFilename(fileName: string): string {
    return fileName.replace(/["\\\r\n]/g, '_');
}

function buildMultipartFileBody(fileName: string, fileBuffer: Buffer): { body: Buffer; boundary: string } {
    const boundary = `----pomelobot-${randomUUID()}`;
    const safeFileName = escapeMultipartFilename(fileName);
    const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="media"; filename="${safeFileName}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
        'utf-8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    return { body: Buffer.concat([head, fileBuffer, tail]), boundary };
}

function deriveFileType(fileName: string): string {
    const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
    return ext || 'txt';
}

async function uploadMessageFile(
    config: DingTalkConfig,
    filePath: string,
    log?: Logger
): Promise<{ mediaId: string; fileName: string; fileType: string }> {
    const fileName = path.basename(filePath);
    const fileType = deriveFileType(fileName);
    const stat = await statFile(filePath);
    if (!stat.isFile()) {
        throw new Error(`不是文件: ${filePath}`);
    }
    if (stat.size <= 0) {
        throw new Error(`文件为空: ${filePath}`);
    }
    if (stat.size > MAX_DINGTALK_FILE_BYTES) {
        throw new Error(`文件大小超过 10MB 限制: ${fileName}`);
    }

    const token = await getAccessToken(config, log);
    const fileBuffer = await readFileAsync(filePath);
    const multipart = buildMultipartFileBody(fileName, fileBuffer);
    const uploadUrl = `${DINGTALK_LEGACY_API}/media/upload?access_token=${encodeURIComponent(token)}&type=file`;

    const resp = await axios.post<UploadMediaResponse>(uploadUrl, multipart.body, {
        headers: {
            'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
            'Content-Length': String(multipart.body.length),
        },
        timeout: 20000,
        maxBodyLength: Infinity,
    });

    if (resp.data?.errcode && resp.data.errcode !== 0) {
        throw new Error(`上传文件失败: ${resp.data.errmsg || 'unknown error'} (errcode=${resp.data.errcode})`);
    }

    const mediaId = resp.data?.media_id;
    if (!mediaId) {
        throw new Error('上传文件失败: 未返回 media_id');
    }

    return { mediaId, fileName, fileType };
}

/**
 * Get Access Token with caching
 */
export async function getAccessToken(config: DingTalkConfig, log?: Logger): Promise<string> {
    const now = Date.now();
    if (accessToken && accessTokenExpiry > now + 60000) {
        return accessToken;
    }

    log?.debug?.('[DingTalk] Fetching new access token...');

    const response = await axios.post<TokenInfo>(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
        appKey: config.clientId,
        appSecret: config.clientSecret,
    });

    accessToken = response.data.accessToken;
    accessTokenExpiry = now + response.data.expireIn * 1000;

    log?.debug?.('[DingTalk] Access token obtained, expires in', response.data.expireIn, 'seconds');

    return accessToken!;
}

/**
 * Detect if text contains markdown and extract title
 */
function detectMarkdownAndExtractTitle(
    text: string,
    options: SendMessageOptions,
    defaultTitle: string
): { useMarkdown: boolean; title: string } {
    const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(text) || text.includes('\n');
    const useMarkdown = options.useMarkdown !== false && (options.useMarkdown || hasMarkdown);

    const title =
        options.title ||
        (useMarkdown
            ? text
                .split('\n')[0]
                .replace(/^[#*\s\->]+/, '')
                .slice(0, 20) || defaultTitle
            : defaultTitle);

    return { useMarkdown, title };
}

/**
 * Send message via sessionWebhook (for replying in conversation)
 */
export async function sendBySession(
    config: DingTalkConfig,
    sessionWebhook: string,
    text: string,
    options: SendMessageOptions = {},
    log?: Logger
): Promise<void> {
    const token = await getAccessToken(config, log);

    const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'SREBot 消息');

    let body: SessionWebhookBody;
    if (useMarkdown) {
        let finalText = text;
        if (options.atUserId) finalText = `${finalText} @${options.atUserId}`;
        body = { msgtype: 'markdown', markdown: { title, text: finalText } };
    } else {
        body = { msgtype: 'text', text: { content: text } };
    }

    if (options.atUserId) {
        body.at = { atUserIds: [options.atUserId], isAtAll: false };
    }

    log?.debug?.(`[DingTalk] Sending message via sessionWebhook, type: ${body.msgtype}`);

    await axios({
        url: sessionWebhook,
        method: 'POST',
        data: body,
        headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
        },
    });
}

/**
 * Send proactive text/markdown message via DingTalk OpenAPI
 */
export async function sendProactiveMessage(
    config: DingTalkConfig,
    target: string,
    text: string,
    options: SendMessageOptions = {},
    log?: Logger
): Promise<void> {
    const token = await getAccessToken(config, log);
    const isGroup = target.startsWith('cid');

    const url = isGroup
        ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
        : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

    const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'SREBot 提醒');

    log?.debug?.(`[DingTalk] Sending proactive message to ${isGroup ? 'group' : 'user'} ${target}`);

    const msgKey = useMarkdown ? 'sampleMarkdown' : 'sampleText';

    const payload: Record<string, unknown> = {
        robotCode: config.robotCode || config.clientId,
        msgKey,
        msgParam: JSON.stringify({
            title,
            text,
        }),
    };

    if (isGroup) {
        payload.openConversationId = target;
    } else {
        payload.userIds = [target];
    }

    await axios({
        url,
        method: 'POST',
        data: payload,
        headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
        },
    });
}

export async function sendProactiveFile(
    config: DingTalkConfig,
    target: string,
    filePath: string,
    log?: Logger
): Promise<void> {
    const token = await getAccessToken(config, log);
    const isGroup = target.startsWith('cid');
    const url = isGroup
        ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
        : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
    const uploaded = await uploadMessageFile(config, filePath, log);

    const payload: Record<string, unknown> = {
        robotCode: config.robotCode || config.clientId,
        msgKey: 'sampleFile',
        msgParam: JSON.stringify({
            mediaId: uploaded.mediaId,
            fileName: uploaded.fileName,
            fileType: uploaded.fileType,
        }),
    };

    if (isGroup) {
        payload.openConversationId = target;
    } else {
        payload.userIds = [target];
    }

    log?.info?.(
        `[DingTalk] Sending file to ${isGroup ? 'group' : 'user'} ${target}: ${uploaded.fileName} (${uploaded.fileType})`
    );

    await axios({
        url,
        method: 'POST',
        data: payload,
        headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
        },
    });
}

// ============ AI Card API Functions ============

/**
 * Create and deliver an AI Card
 */
export async function createAICard(
    config: DingTalkConfig,
    conversationId: string,
    isDirect: boolean,
    userId: string | undefined,
    log?: Logger,
    options: { trackActive?: boolean } = {}
): Promise<AICardInstance | null> {
    try {
        const token = await getAccessToken(config, log);
        const cardInstanceId = `card_${randomUUID()}`;
        const targetKey = getTargetKey(conversationId, isDirect, userId);
        const trackActive = options.trackActive !== false;

        log?.info?.(`[DingTalk][AICard] Creating card: ${cardInstanceId}`);

        const isGroup = !isDirect;
        const targetUserId = userId || conversationId;

        const createAndDeliverBody = {
            cardTemplateId: config.cardTemplateId || '382e4302-551d-4880-bf29-a30acfab2e71.schema',
            outTrackId: cardInstanceId,
            cardData: {
                cardParamMap: {},
            },
            callbackType: 'STREAM',
            imGroupOpenSpaceModel: { supportForward: true },
            imRobotOpenSpaceModel: { supportForward: true },
            openSpaceId: isGroup
                ? `dtv1.card//IM_GROUP.${conversationId}`
                : `dtv1.card//IM_ROBOT.${targetUserId}`,
            userIdType: 1,
            imGroupOpenDeliverModel: isGroup ? { robotCode: config.robotCode || config.clientId } : undefined,
            imRobotOpenDeliverModel: !isGroup ? { spaceType: 'IM_ROBOT' } : undefined,
        };

        if (!isGroup && !userId) {
            log?.warn?.('[DingTalk][AICard] userId missing for direct chat, falling back to conversationId');
        }

        log?.debug?.(`[DingTalk][AICard] Request body: ${JSON.stringify(createAndDeliverBody)}`);

        const resp = await axios.post(
            `${DINGTALK_API}/v1.0/card/instances/createAndDeliver`,
            createAndDeliverBody,
            {
                headers: {
                    'x-acs-dingtalk-access-token': token,
                    'Content-Type': 'application/json',
                },
                timeout: 15000, // 15 second timeout
            }
        );

        log?.info?.(`[DingTalk][AICard] Card created successfully, status: ${resp.status}`);

        const aiCardInstance: AICardInstance = {
            cardInstanceId,
            accessToken: token,
            conversationId,
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            state: AICardStatus.PROCESSING,
            targetKey,
        };

        aiCardInstances.set(cardInstanceId, aiCardInstance);
        if (trackActive) {
            activeCardsByTarget.set(targetKey, cardInstanceId);
        }

        return aiCardInstance;
    } catch (err) {
        const error = err as Error & { response?: { status: number; data: unknown } };
        log?.error?.(`[DingTalk][AICard] Create failed: ${error.message}`);
        if (error.response) {
            log?.error?.(`[DingTalk][AICard] Response status: ${error.response.status}, data: ${JSON.stringify(error.response.data)}`);
        }
        return null;
    }
}

/**
 * Send a one-off approval card (AI card template)
 */
export async function sendExecApprovalCard(
    config: DingTalkConfig,
    conversationId: string,
    isDirect: boolean,
    userId: string | undefined,
    content: string,
    log?: Logger
): Promise<void> {
    const card = await createAICard(config, conversationId, isDirect, userId, log, { trackActive: false });
    if (!card) {
        throw new Error('Failed to create approval card');
    }
    await finishAICard(card, content, config, log);
}

/**
 * Send an interactive approval card with buttons
 */
export async function sendExecApprovalButtonCard(
    config: DingTalkConfig,
    conversationId: string,
    isDirect: boolean,
    userId: string | undefined,
    cardParamMap: Record<string, string>,
    log?: Logger
): Promise<{ cardInstanceId: string }> {
    const templateId = config.execApprovals?.templateId;
    if (!templateId) {
        throw new Error('Missing exec approval card templateId');
    }

    const token = await getAccessToken(config, log);
    const cardInstanceId = `card_${randomUUID()}`;
    const isGroup = !isDirect;
    const targetUserId = userId || conversationId;

    const createAndDeliverBody = {
        cardTemplateId: templateId,
        outTrackId: cardInstanceId,
        cardData: { cardParamMap },
        // In Stream mode (dingtalk-stream), callbacks are delivered via TOPIC_CARD.
        // Using STREAM here avoids createAndDeliver failures seen with CALLBACK.
        callbackType: 'STREAM',
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
        openSpaceId: isGroup
            ? `dtv1.card//IM_GROUP.${conversationId}`
            : `dtv1.card//IM_ROBOT.${targetUserId}`,
        userIdType: 1,
        imGroupOpenDeliverModel: isGroup ? { robotCode: config.robotCode || config.clientId } : undefined,
        imRobotOpenDeliverModel: !isGroup ? { spaceType: 'IM_ROBOT' } : undefined,
    };

    log?.debug?.(`[DingTalk][AICard] Exec approval card body: ${JSON.stringify(createAndDeliverBody)}`);

    const resp = await postWithRetry(
        `${DINGTALK_API}/v1.0/card/instances/createAndDeliver`,
        createAndDeliverBody,
        token,
        log
    );

    log?.info?.(`[DingTalk][AICard] Exec approval card sent, status: ${resp.status}`);
    return { cardInstanceId };
}

async function postWithRetry(
    url: string,
    data: Record<string, unknown>,
    token: string,
    log?: Logger
): Promise<{ status: number; data: unknown }> {
    const maxRetries = 3;
    const baseDelay = 500;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            const resp = await axios.post(url, data, {
                headers: {
                    'x-acs-dingtalk-access-token': token,
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
            });
            return { status: resp.status, data: resp.data };
        } catch (err) {
            const error = err as { response?: { status?: number; data?: unknown } };
            const status = error.response?.status;
            const retryable =
                status === 429 || status === 502 || status === 503 || status === 504 || status == null;

            if (!retryable || attempt === maxRetries) {
                throw err;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            log?.warn?.(
                `[DingTalk][AICard] createAndDeliver retry ${attempt + 1}/${maxRetries} after ${delay}ms (status=${status ?? 'no-response'})`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    throw new Error('createAndDeliver retry exhausted');
}

/**
 * Stream update AI Card content
 */
export async function streamAICard(
    card: AICardInstance,
    content: string,
    finished: boolean = false,
    config: DingTalkConfig,
    log?: Logger
): Promise<void> {
    // Refresh token if needed (tokens expire after 2 hours)
    const tokenAge = Date.now() - card.createdAt;
    const TOKEN_REFRESH_THRESHOLD = 90 * 60 * 1000; // 1.5 hours

    if (tokenAge > TOKEN_REFRESH_THRESHOLD) {
        log?.debug?.('[DingTalk][AICard] Refreshing token...');
        try {
            card.accessToken = await getAccessToken(config, log);
        } catch (err) {
            log?.warn?.(`[DingTalk][AICard] Token refresh failed: ${(err as Error).message}`);
        }
    }

    const streamBody: AICardStreamingRequest = {
        outTrackId: card.cardInstanceId,
        guid: randomUUID(),
        key: 'content',
        content: content,
        isFull: true,
        isFinalize: finished,
        isError: false,
    };

    log?.info?.(`[DingTalk][AICard] Streaming update, len=${content.length}, final=${finished}`);

    try {
        const resp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, {
            headers: {
                'x-acs-dingtalk-access-token': card.accessToken,
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        });

        log?.info?.(`[DingTalk][AICard] Stream update success, status: ${resp.status}`);

        card.lastUpdated = Date.now();
        if (finished) {
            card.state = AICardStatus.FINISHED;
        } else if (card.state === AICardStatus.PROCESSING) {
            card.state = AICardStatus.INPUTING;
        }
    } catch (err) {
        const error = err as Error & { response?: { status: number; data: unknown } };

        // Log detailed error info
        if (error.response) {
            log?.error?.(`[DingTalk][AICard] Stream failed: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else {
            log?.error?.(`[DingTalk][AICard] Stream failed: ${error.message}`);
        }

        // Try token refresh on 401
        if (error.response?.status === 401) {
            log?.warn?.('[DingTalk][AICard] Got 401, retrying with fresh token...');
            try {
                card.accessToken = await getAccessToken(config, log);
                await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, {
                    headers: {
                        'x-acs-dingtalk-access-token': card.accessToken,
                        'Content-Type': 'application/json',
                    },
                });
                card.lastUpdated = Date.now();
                if (finished) {
                    card.state = AICardStatus.FINISHED;
                }
                return;
            } catch (retryErr) {
                log?.error?.(`[DingTalk][AICard] Retry failed: ${(retryErr as Error).message}`);
            }
        }

        card.state = AICardStatus.FAILED;
        card.lastUpdated = Date.now();
        throw error;
    }
}

/**
 * Finalize AI Card
 */
export async function finishAICard(
    card: AICardInstance,
    content: string,
    config: DingTalkConfig,
    log?: Logger
): Promise<void> {
    log?.debug?.(`[DingTalk][AICard] Finalizing card, content length: ${content.length}`);
    await streamAICard(card, content, true, config, log);
}

/**
 * Get cached AI Card instance
 */
export function getAICardInstance(cardInstanceId: string): AICardInstance | undefined {
    return aiCardInstances.get(cardInstanceId);
}

/**
 * Check if card is in terminal state
 */
export function isCardFinished(card: AICardInstance): boolean {
    return card.state === AICardStatus.FINISHED || card.state === AICardStatus.FAILED;
}
