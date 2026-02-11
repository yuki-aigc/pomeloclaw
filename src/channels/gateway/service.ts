import { withChannelConversationContext } from '../context.js';
import type {
    ChannelAdapter,
    ChannelAdapterRuntime,
    ChannelInboundMessage,
    ChannelProactiveRequest,
    GatewayDispatchResult,
    GatewayLogger,
    GatewayProcessResult,
    GatewayServiceOptions,
} from './types.js';

const DEFAULT_DEDUPE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_DEDUPE_KEYS = 5000;

function createGatewayLogger(input?: Partial<GatewayLogger>): GatewayLogger {
    return {
        debug: input?.debug ?? (() => undefined),
        info: input?.info ?? (() => undefined),
        warn: input?.warn ?? (() => undefined),
        error: input?.error ?? (() => undefined),
    };
}

export class GatewayService {
    private readonly adapters = new Map<string, ChannelAdapter>();
    private readonly logger: GatewayLogger;
    private readonly onProcessInbound: (message: ChannelInboundMessage) => Promise<GatewayProcessResult | void>;
    private readonly dedupeTtlMs: number;
    private readonly maxDedupeKeys: number;

    private readonly seenInboundKeys = new Map<string, number>();
    private started = false;

    constructor(options: GatewayServiceOptions) {
        this.logger = createGatewayLogger(options.logger);
        this.onProcessInbound = options.onProcessInbound;
        this.dedupeTtlMs = Math.max(1000, Math.floor(options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS));
        this.maxDedupeKeys = Math.max(100, Math.floor(options.maxDedupeKeys ?? DEFAULT_MAX_DEDUPE_KEYS));
    }

    registerAdapter(adapter: ChannelAdapter): void {
        const key = adapter.channel.trim();
        if (!key) {
            throw new Error('adapter.channel 不能为空');
        }
        if (this.adapters.has(key)) {
            throw new Error(`adapter 已存在: ${key}`);
        }
        this.adapters.set(key, adapter);
        this.logger.info(`[Gateway] adapter registered: ${key}`);
    }

    unregisterAdapter(channel: string): boolean {
        const key = channel.trim();
        if (!key) return false;
        if (this.started) {
            throw new Error(`Gateway 已启动，不能卸载 adapter: ${key}`);
        }
        const removed = this.adapters.delete(key);
        if (removed) {
            this.logger.info(`[Gateway] adapter unregistered: ${key}`);
        }
        return removed;
    }

    getAdapter(channel: string): ChannelAdapter | undefined {
        return this.adapters.get(channel.trim());
    }

    listAdapters(): string[] {
        return Array.from(this.adapters.keys()).sort();
    }

    async start(): Promise<void> {
        if (this.started) return;

        const startErrors: string[] = [];
        for (const adapter of this.adapters.values()) {
            try {
                const runtime: ChannelAdapterRuntime = {
                    onInbound: (message) => this.dispatchInbound(message),
                    logger: this.logger,
                };
                await adapter.start(runtime);
                this.logger.info(`[Gateway] adapter started: ${adapter.channel}`);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                startErrors.push(`${adapter.channel}: ${reason}`);
                this.logger.error(`[Gateway] adapter start failed: ${adapter.channel} - ${reason}`);
            }
        }

        if (startErrors.length > 0) {
            throw new Error(`Gateway 启动失败: ${startErrors.join(' | ')}`);
        }

        this.started = true;
        this.logger.info(`[Gateway] started with adapters: ${this.listAdapters().join(', ') || '(none)'}`);
    }

    async stop(): Promise<void> {
        if (!this.started) return;

        const stopErrors: string[] = [];
        const adapters = Array.from(this.adapters.values()).reverse();
        for (const adapter of adapters) {
            try {
                await adapter.stop();
                this.logger.info(`[Gateway] adapter stopped: ${adapter.channel}`);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                stopErrors.push(`${adapter.channel}: ${reason}`);
                this.logger.warn(`[Gateway] adapter stop failed: ${adapter.channel} - ${reason}`);
            }
        }

        this.started = false;
        this.seenInboundKeys.clear();

        if (stopErrors.length > 0) {
            throw new Error(`Gateway 停止失败: ${stopErrors.join(' | ')}`);
        }
        this.logger.info('[Gateway] stopped');
    }

    async dispatchInbound(message: ChannelInboundMessage): Promise<GatewayDispatchResult> {
        const channel = message.channel.trim();
        if (!channel) {
            return { status: 'error', reason: 'channel 不能为空' };
        }
        const adapter = this.adapters.get(channel);
        if (!adapter) {
            return { status: 'error', reason: `未注册的 channel: ${channel}` };
        }

        const dedupeKey = this.buildDedupeKey(message);
        if (dedupeKey && this.isDuplicate(dedupeKey)) {
            this.logger.debug(`[Gateway] duplicate inbound skipped: ${dedupeKey}`);
            return { status: 'duplicate', reason: 'duplicate inbound' };
        }

        try {
            const processResult = await withChannelConversationContext(
                {
                    channel,
                    conversationId: message.conversationId,
                    isDirect: message.isDirect,
                    senderId: message.senderId,
                    senderName: message.senderName,
                    sessionWebhook: message.sessionWebhook,
                    workspaceRoot: message.workspaceRoot,
                    pendingReplyFiles: [],
                },
                () => this.onProcessInbound(message)
            );

            if (processResult?.skipReply) {
                return { status: 'skipped', reason: 'skipReply=true' };
            }

            if (processResult?.reply) {
                await adapter.sendReply({
                    inbound: message,
                    message: processResult.reply,
                });
            }

            return { status: 'processed' };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.error(`[Gateway] dispatch inbound failed (${channel}): ${reason}`);
            return { status: 'error', reason };
        }
    }

    async sendProactive(request: ChannelProactiveRequest): Promise<void> {
        const channel = request.channel.trim();
        if (!channel) {
            throw new Error('channel 不能为空');
        }
        const adapter = this.adapters.get(channel);
        if (!adapter) {
            throw new Error(`未注册的 channel: ${channel}`);
        }
        if (!adapter.sendProactive) {
            throw new Error(`channel ${channel} 不支持主动消息`);
        }
        await adapter.sendProactive(request);
    }

    private buildDedupeKey(message: ChannelInboundMessage): string {
        const explicit = message.idempotencyKey?.trim();
        if (explicit) {
            return `${message.channel}:${explicit}`;
        }
        return `${message.channel}:${message.messageId}`;
    }

    private isDuplicate(key: string): boolean {
        const now = Date.now();
        this.cleanupDedupe(now);

        const expiresAt = this.seenInboundKeys.get(key);
        if (typeof expiresAt === 'number' && expiresAt > now) {
            return true;
        }

        this.seenInboundKeys.set(key, now + this.dedupeTtlMs);
        if (this.seenInboundKeys.size > this.maxDedupeKeys) {
            this.pruneDedupeSize();
        }
        return false;
    }

    private cleanupDedupe(now: number): void {
        for (const [key, expiresAt] of this.seenInboundKeys.entries()) {
            if (expiresAt <= now) {
                this.seenInboundKeys.delete(key);
            }
        }
    }

    private pruneDedupeSize(): void {
        while (this.seenInboundKeys.size > this.maxDedupeKeys) {
            const first = this.seenInboundKeys.keys().next();
            if (first.done) {
                return;
            }
            this.seenInboundKeys.delete(first.value);
        }
    }
}
