import type { AgentMemorySessionIsolationConfig } from '../config.js';
import { getChannelConversationContext } from '../channels/context.js';

export type MemoryScopeKind = 'main' | 'direct' | 'group';

export interface MemoryScope {
    key: string;
    kind: MemoryScopeKind;
}

function sanitizeScopePart(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return 'unknown';
    return trimmed.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function buildDirectScopeKey(channel: string, senderId: string): string {
    const sender = sanitizeScopePart(senderId);
    const channelPart = sanitizeScopePart(channel);
    if (channelPart === 'dingtalk') {
        return `direct_${sender}`;
    }
    return `direct_${channelPart}_${sender}`;
}

function buildGroupScopeKey(prefix: string, channel: string, conversationId: string): string {
    const conversation = sanitizeScopePart(conversationId);
    const channelPart = sanitizeScopePart(channel);
    if (channelPart === 'dingtalk') {
        return `${prefix}${conversation}`;
    }
    return `${prefix}${channelPart}_${conversation}`;
}

function resolveDirectScopeMode(config: AgentMemorySessionIsolationConfig, channel: string): 'main' | 'direct' {
    if (sanitizeScopePart(channel) === 'web') {
        return config.web_direct_scope;
    }
    return config.direct_scope;
}

export function resolveMemoryScope(config: AgentMemorySessionIsolationConfig): MemoryScope {
    const context = getChannelConversationContext();
    if (!context || !config.enabled) {
        return { key: 'main', kind: 'main' };
    }

    if (context.isDirect) {
        if (resolveDirectScopeMode(config, context.channel) === 'direct') {
            return {
                key: buildDirectScopeKey(context.channel, context.senderId),
                kind: 'direct',
            };
        }
        return { key: 'main', kind: 'main' };
    }

    return {
        key: buildGroupScopeKey(config.group_scope_prefix, context.channel, context.conversationId),
        kind: 'group',
    };
}
