import type { DingTalkConfig } from '../../config.js';
import { sendBySession, sendProactiveMessage } from './client.js';
import type { Logger } from './types.js';
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

    constructor(private readonly options: DingTalkChannelAdapterOptions) {}

    async start(runtime: ChannelAdapterRuntime): Promise<void> {
        this.runtime = runtime;
        this.started = true;
        this.options.log.info('[DingTalkAdapter] started (skeleton mode)');
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

    // In skeleton phase, existing dingtalk.ts still owns DWClient callbacks.
    // Later we can forward those callbacks to this method and let GatewayService handle dispatch.
    async handleInbound(message: ChannelInboundMessage): Promise<GatewayDispatchResult> {
        if (!this.started || !this.runtime) {
            throw new Error('DingTalk adapter is not started');
        }
        return this.runtime.onInbound({
            ...message,
            channel: 'dingtalk',
        });
    }
}

export function createDingTalkChannelAdapter(options: DingTalkChannelAdapterOptions): DingTalkChannelAdapter {
    return new DingTalkChannelAdapter(options);
}
