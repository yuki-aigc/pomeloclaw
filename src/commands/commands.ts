import crypto from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CompactionConfig } from '../compaction/index.js';
import type { LLMProvider } from '../config.js';
import {
    formatTokenCount,
    getCompactionHardContextBudget,
    getContextUsageInfo,
    getEffectiveAutoCompactThreshold,
} from '../compaction/index.js';

export interface ModelOption {
    alias: string;
    provider: LLMProvider;
    model: string;
}

export interface CommandResult {
    handled: boolean;
    response?: string;
    action?: 'new_session' | 'compact' | 'switch_model' | 'info';
    newThreadId?: string;
    compactInstructions?: string;
    modelAlias?: string;
}

export interface CommandContext {
    model: BaseChatModel;
    config: CompactionConfig;
    currentTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    compactionCount: number;
    threadId: string;
    sessionStartTime: Date;
    lastUpdatedAt: Date;
    appVersion: string;
    activeModelAlias: string;
    activeModel?: ModelOption;
    activeModelApiKeyMasked?: string;
    runtimeMode?: string;
    thinkLevel?: string;
    queueName?: string;
    queueDepth?: number;
    modelOptions: ModelOption[];
}

/**
 * Parse slash command from user input
 */
export function parseCommand(input: string): { command: string; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
        return null;
    }

    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex === -1) {
        return { command: trimmed.toLowerCase(), args: '' };
    }

    return {
        command: trimmed.slice(0, spaceIndex).toLowerCase(),
        args: trimmed.slice(spaceIndex + 1).trim(),
    };
}

/**
 * Handle /new command - start a new session
 */
function handleNewCommand(): CommandResult {
    const newThreadId = `thread-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    return {
        handled: true,
        action: 'new_session',
        newThreadId,
        response: `🆕 新会话已创建。\n会话 ID: ${newThreadId.slice(0, 20)}...`,
    };
}

/**
 * Handle /compact command - compact context
 */
function handleCompactCommand(args: string): CommandResult {
    return {
        handled: true,
        action: 'compact',
        compactInstructions: args || undefined,
    };
}

function handleModelsCommand(context: CommandContext): CommandResult {
    const modelList = context.modelOptions
        .map((item) => `${item.alias === context.activeModelAlias ? '•' : ' '} ${item.alias} (${item.provider}) -> ${item.model}`)
        .join('\n');

    return {
        handled: true,
        action: 'info',
        response: modelList
            ? `🤖 **已配置模型**\n\n${modelList}`
            : 'ℹ️ 当前没有可用模型配置。',
    };
}

function handleModelCommand(args: string, context: CommandContext): CommandResult {
    const alias = args.trim();
    if (!alias) {
        return {
            handled: true,
            action: 'info',
            response: `ℹ️ 用法: /model <模型别名>\n当前模型: ${context.activeModelAlias}`,
        };
    }

    const exists = context.modelOptions.some((item) => item.alias === alias);
    if (!exists) {
        return {
            handled: true,
            action: 'info',
            response: `❌ 未找到模型别名: ${alias}\n使用 /models 查看可用模型。`,
        };
    }

    if (alias === context.activeModelAlias) {
        return {
            handled: true,
            action: 'info',
            response: `ℹ️ 当前已在使用模型: ${alias}`,
        };
    }

    return {
        handled: true,
        action: 'switch_model',
        modelAlias: alias,
    };
}

/**
 * Handle /status command - show current status
 */
function handleStatusCommand(context: CommandContext): CommandResult {
    const contextRatio = (context.currentTokens / context.config.context_window) * 100;
    const contextPercent = contextRatio >= 1
        ? Math.round(contextRatio)
        : Number(contextRatio.toFixed(1));
    const model = context.activeModel;
    const modelLabel = model
        ? `${model.provider}/${model.model}`
        : context.activeModelAlias;
    const keyLabel = context.activeModelApiKeyMasked || '(not set)';
    const runtimeMode = context.runtimeMode || 'direct';
    const thinkLevel = context.thinkLevel || 'low';
    const queueName = context.queueName || 'collect';
    const queueDepth = context.queueDepth ?? 0;
    const effectiveThreshold = getEffectiveAutoCompactThreshold(context.config);
    const hardBudget = getCompactionHardContextBudget(context.config);

    const response = `🤖 SRE Bot ${context.appVersion}
🧠 Model: ${modelLabel} · 🔑 api-key ${keyLabel} (${model?.provider || 'n/a'}:${context.activeModelAlias})
🧮 Tokens: ${formatTokenCount(context.totalInputTokens)} in / ${formatTokenCount(context.totalOutputTokens)} out
📚 Context: ${formatTokenCount(context.currentTokens)}/${formatTokenCount(context.config.context_window)} (${contextPercent}%) · 🧹 Compactions: ${context.compactionCount}
🧵 Session: ${context.threadId} • updated ${formatRelativeTime(context.lastUpdatedAt)}
⚙️ Runtime: ${runtimeMode} · Think: ${thinkLevel}
🪢 Queue: ${queueName} (depth ${queueDepth})

${getContextUsageInfo(context.currentTokens, context.config)}
自动压缩阈值: ${formatTokenCount(effectiveThreshold)}（hard budget: ${formatTokenCount(hardBudget)}）`;

    return {
        handled: true,
        action: 'info',
        response,
    };
}

function formatRelativeTime(updatedAt: Date): string {
    const diffMs = Math.max(0, Date.now() - updatedAt.getTime());
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Handle /help command - show available commands
 */
function handleHelpCommand(): CommandResult {
    const response = `📖 **可用命令**

/new - 开始新会话（清空上下文）
/compact [说明] - 手动压缩上下文（可提供压缩重点说明）
/models - 列出已配置模型
/model <别名> - 切换当前模型
/status - 显示当前会话状态
/skills - 列出当前已安装技能
/skill-install <来源> - 远程或本地安装技能
/skill-remove <名称> - 删除已安装技能
/skill-reload - 重新加载技能索引
/help - 显示此帮助信息

**提示**: 当上下文过长时，系统会自动压缩。`;

    return {
        handled: true,
        action: 'info',
        response,
    };
}

/**
 * Handle a slash command
 */
export async function handleCommand(
    input: string,
    context: CommandContext,
    messages: import('@langchain/core/messages').BaseMessage[],
): Promise<CommandResult> {
    const parsed = parseCommand(input);

    if (!parsed) {
        return { handled: false };
    }

    switch (parsed.command) {
        case '/new':
        case '/reset':
            return handleNewCommand();

        case '/compact':
            return handleCompactCommand(parsed.args);

        case '/models':
            return handleModelsCommand(context);

        case '/model':
            return handleModelCommand(parsed.args, context);

        case '/status':
            return handleStatusCommand(context);

        case '/help':
        case '/?':
            return handleHelpCommand();

        default:
            return {
                handled: true,
                action: 'info',
                response: `❓ 未知命令: ${parsed.command}\n输入 /help 查看可用命令。`,
            };
    }
}
