import type { DingTalkConfig } from '../../config.js';
import { sendBySession, sendProactiveMessage } from './client.js';
import { tryHandleExecApprovalCardCallback } from './approvals.js';
import type { Logger } from './types.js';
import type { DingTalkInboundMessage, StreamCallbackResponse } from './types.js';
import { TOPIC_CARD, TOPIC_ROBOT, type DWClient } from 'dingtalk-stream';
import type {
    ChannelAdapter,
    ChannelAdapterRuntime,
    ChannelInboundMessage,
    ChannelProactiveRequest,
    ChannelReplyRequest,
    GatewayDispatchResult,
} from '../gateway/types.js';

export interface DingTalkChannelAdapterOptions {
    config: DingTalkConfig;
    log: Logger;
    client: DWClient;
    isShuttingDown?: () => boolean;
}

export class DingTalkChannelAdapter implements ChannelAdapter {
    readonly channel = 'dingtalk';
    readonly capabilities = {
        supportsStreamingReply: true,
        supportsApprovalFlow: true,
        supportsAttachmentReply: true,
        supportsProactiveMessage: true,
    };

    private runtime: ChannelAdapterRuntime | null = null;
    private started = false;
    private callbacksRegistered = false;
    private readonly seenGroupConversations = new Map<string, string>();

    constructor(private readonly options: DingTalkChannelAdapterOptions) {}

    async start(runtime: ChannelAdapterRuntime): Promise<void> {
        if (this.started) {
            return;
        }
        this.runtime = runtime;
        if (!this.callbacksRegistered) {
            this.registerCallbackListeners();
            this.callbacksRegistered = true;
        }
        this.started = true;
        this.options.log.info('[DingTalkAdapter] started');
    }

    async stop(): Promise<void> {
        this.started = false;
        this.runtime = null;
        this.options.log.info('[DingTalkAdapter] stopped');
    }

    async sendReply(request: ChannelReplyRequest): Promise<void> {
        const sessionWebhook = request.inbound.sessionWebhook?.trim();
        if (!sessionWebhook) {
            throw new Error('DingTalk reply requires inbound.sessionWebhook');
        }

        const atUserId = request.message.atUserId !== undefined
            ? request.message.atUserId
            : request.inbound.isDirect
                ? null
                : request.inbound.senderId;

        await sendBySession(
            this.options.config,
            sessionWebhook,
            request.message.text,
            {
                title: request.message.title,
                useMarkdown: request.message.useMarkdown,
                atUserId,
            },
            this.options.log
        );
    }

    async sendProactive(request: ChannelProactiveRequest): Promise<void> {
        await sendProactiveMessage(
            this.options.config,
            request.target,
            request.message.text,
            {
                title: request.message.title,
                useMarkdown: request.message.useMarkdown,
                atUserId: request.message.atUserId,
            },
            this.options.log
        );
    }

    async handleInbound(message: ChannelInboundMessage): Promise<GatewayDispatchResult> {
        if (!this.started || !this.runtime) {
            throw new Error('DingTalk adapter is not started');
        }
        return this.runtime.onInbound({
            ...message,
            channel: 'dingtalk',
        });
    }

    private registerCallbackListeners(): void {
        this.options.client.registerCallbackListener(TOPIC_ROBOT, (res: StreamCallbackResponse) => {
            void this.handleRobotCallback(res);
        });
        this.options.client.registerCallbackListener(TOPIC_CARD, (res: StreamCallbackResponse) => {
            void this.handleCardCallback(res);
        });
    }

    private acknowledgeCallback(messageId?: string): void {
        if (!messageId) {
            return;
        }
        try {
            this.options.client.socketCallBackResponse(messageId, { success: true });
        } catch (error) {
            this.options.log.debug(
                `[DingTalkAdapter] callback ack failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private shouldSkipCallbackAck(): boolean {
        if (!this.options.isShuttingDown?.()) {
            return false;
        }
        return true;
    }

    private async handleRobotCallback(res: StreamCallbackResponse): Promise<void> {
        const messageId = res.headers?.messageId;
        if (this.shouldSkipCallbackAck()) {
            return;
        }
        this.acknowledgeCallback(messageId);

        try {
            const data = JSON.parse(res.data) as DingTalkInboundMessage;
            this.logGroupConversationMapping(data);
            const dispatchResult = await this.handleInbound(
                this.buildGatewayInbound({
                    data,
                    messageIdFromHeader: messageId,
                })
            );
            if (dispatchResult.status === 'error') {
                this.options.log.error(`[DingTalkAdapter] Gateway dispatch failed: ${dispatchResult.reason || '(unknown)'}`);
            } else if (dispatchResult.status === 'duplicate') {
                this.options.log.debug('[DingTalkAdapter] Duplicate inbound message skipped by gateway');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.options.log.error(`[DingTalkAdapter] Error processing robot callback: ${errorMessage}`);
        }
    }

    private async handleCardCallback(res: StreamCallbackResponse): Promise<void> {
        const messageId = res.headers?.messageId;
        if (this.shouldSkipCallbackAck()) {
            return;
        }
        this.acknowledgeCallback(messageId);

        try {
            const payload = JSON.parse(res.data) as Record<string, unknown>;
            this.options.log.debug(`[DingTalkAdapter] Card callback payload: ${JSON.stringify(payload)}`);
            await tryHandleExecApprovalCardCallback({ payload, log: this.options.log });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.options.log.error(`[DingTalkAdapter] Error processing card callback: ${errorMessage}`);
        }
    }

    private logGroupConversationMapping(data: DingTalkInboundMessage): void {
        const isDirect = data.conversationType === '1';
        if (isDirect) {
            return;
        }
        const conversationId = data.conversationId || '';
        const conversationTitle = (data.conversationTitle || '').trim() || '(未命名群)';
        const previousTitle = this.seenGroupConversations.get(conversationId);
        if (!previousTitle || previousTitle !== conversationTitle) {
            this.seenGroupConversations.set(conversationId, conversationTitle);
            this.options.log.info(`[DingTalk] 群会话映射: ${conversationTitle} -> ${conversationId}`);
        }
    }

    private buildGatewayInbound(params: {
        data: DingTalkInboundMessage;
        messageIdFromHeader?: string;
    }): ChannelInboundMessage {
        const { data, messageIdFromHeader } = params;
        const senderId = data.senderStaffId || data.senderId;
        const senderName = data.senderNick || 'Unknown';
        const isDirect = data.conversationType === '1';
        const messageId = data.msgId || messageIdFromHeader || `dingtalk-${Date.now()}`;
        const fallbackText = data.text?.content?.trim() || '';
        const text = fallbackText
            || data.content?.recognition?.trim()
            || (data.msgtype ? `[${data.msgtype}]` : '[消息]');

        return {
            channel: 'dingtalk',
            messageId,
            idempotencyKey: data.msgId || messageIdFromHeader || messageId,
            timestamp: data.createAt || Date.now(),
            conversationId: data.conversationId,
            conversationTitle: data.conversationTitle,
            isDirect,
            senderId,
            senderName,
            sessionWebhook: data.sessionWebhook,
            text,
            messageType: data.msgtype || 'text',
            raw: data,
        };
    }
}

export function createDingTalkChannelAdapter(options: DingTalkChannelAdapterOptions): DingTalkChannelAdapter {
    return new DingTalkChannelAdapter(options);
}
