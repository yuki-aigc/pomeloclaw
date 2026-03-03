import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { countMessageTokensWithModel, countTotalTokensWithModel, estimateMessageTokens } from './compaction.js';
import { WORKING_SUMMARY_REQUIREMENTS, WORKING_SUMMARY_SCHEMA } from './summary-schema.js';

const SUMMARY_MESSAGE_PREFIX = '[对话历史摘要]';
const LEGACY_SUMMARY_MESSAGE_PREFIX = '[Previous conversation summary]';

const SUMMARY_SYSTEM_PROMPT = `你是一个对话摘要助手。请将以下对话历史压缩成简洁的摘要，保留：
1. 当前正在推进的主要任务，以及任务当前所处阶段
2. 最新用户请求、预期产出和当前回答需要接续的方向
3. 已完成进展，以及批次/分页/文件/节点/工单等可执行进度
4. 已承诺但尚未完成的后续动作、待办事项
5. 关键决策、约束、用户偏好、边界条件
6. 未解决的问题、阻塞、风险和需要回访的点
7. 关键事实细节：文件路径、命令、日期、阈值、ID、名称等

输出要求：
- ${WORKING_SUMMARY_REQUIREMENTS.join('\n- ')}

固定结构：
${WORKING_SUMMARY_SCHEMA}`;

const SUMMARY_USER_TEMPLATE = `请合并已有摘要与本轮需要压缩的旧消息，生成一份新的统一摘要。

【已有摘要】
{existingSummary}

【本轮需要压缩的旧消息】
{messages}

请输出新的统一摘要：`;

function getMessageText(message: BaseMessage): string {
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function isSummaryMessage(message: BaseMessage): boolean {
    if (message._getType() !== 'system') {
        return false;
    }
    const content = getMessageText(message).trim();
    return content.startsWith(SUMMARY_MESSAGE_PREFIX) || content.startsWith(LEGACY_SUMMARY_MESSAGE_PREFIX);
}

function stripSummaryPrefix(content: string): string {
    const normalized = content.trim();
    if (normalized.startsWith(SUMMARY_MESSAGE_PREFIX)) {
        return normalized.slice(SUMMARY_MESSAGE_PREFIX.length).trimStart();
    }
    if (normalized.startsWith(LEGACY_SUMMARY_MESSAGE_PREFIX)) {
        return normalized.slice(LEGACY_SUMMARY_MESSAGE_PREFIX.length).trimStart();
    }
    return normalized;
}

function formatExistingSummary(messages: BaseMessage[]): string {
    const summaries = messages
        .filter(isSummaryMessage)
        .map((message) => stripSummaryPrefix(getMessageText(message)))
        .map((text) => text.trim())
        .filter(Boolean);

    if (summaries.length === 0) {
        return '无';
    }

    return summaries.join('\n\n---\n\n');
}

/**
 * Generate a summary of messages using LLM
 */
export async function generateSummary(
    messages: BaseMessage[],
    model: BaseChatModel,
    customInstructions?: string,
    existingSummary?: string,
): Promise<string> {
    const normalizedExistingSummary = (existingSummary ?? '').trim();
    if (messages.length === 0 && !normalizedExistingSummary) {
        return '无历史对话。';
    }

    // Format messages for summarization
    const formattedMessages = messages.map(msg => {
        const role = msg._getType() === 'human' ? '用户' :
            msg._getType() === 'ai' ? '助手' :
                msg._getType() === 'system' ? '系统' : '其他';
        const content = getMessageText(msg);
        return `[${role}]: ${content}`;
    }).join('\n\n');

    const systemPrompt = customInstructions
        ? `${SUMMARY_SYSTEM_PROMPT}\n\n额外要求：${customInstructions}`
        : SUMMARY_SYSTEM_PROMPT;

    const userPrompt = SUMMARY_USER_TEMPLATE
        .replace('{existingSummary}', normalizedExistingSummary || '无')
        .replace('{messages}', formattedMessages || '无');

    try {
        const response = await model.invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
        ]);

        const summary = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);

        return summary.trim();
    } catch (error) {
        console.error('Failed to generate summary:', error);
        if (normalizedExistingSummary) {
            return normalizedExistingSummary;
        }
        // Fallback: return a simple description
        const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
        return `[历史对话包含 ${messages.length} 条消息，约 ${totalTokens} tokens，摘要生成失败]`;
    }
}

/**
 * Compact messages by summarizing old ones and keeping recent
 */
export async function compactMessages(
    messages: BaseMessage[],
    model: BaseChatModel,
    maxTokens: number,
    customInstructions?: string,
): Promise<{
    messages: BaseMessage[];
    summary: string;
    tokensBefore: number;
    tokensAfter: number;
}> {
    const tokensBefore = await countTotalTokensWithModel(messages, model);

    if (tokensBefore <= maxTokens) {
        return {
            messages,
            summary: '',
            tokensBefore,
            tokensAfter: tokensBefore,
        };
    }

    // Separate system messages and conversational messages
    const summaryMessages = messages.filter(isSummaryMessage);
    const systemMessages = messages.filter(m => m._getType() === 'system' && !isSummaryMessage(m));
    const conversationMessages = messages.filter(m => m._getType() !== 'system');
    const existingSummary = formatExistingSummary(summaryMessages);

    // Calculate how many tokens we can use for conversation
    const systemTokens = await countTotalTokensWithModel(systemMessages, model);
    const availableForConversation = maxTokens - systemTokens - 500; // Reserve 500 for summary

    // Find the split point - keep recent messages within budget
    const conversationTokenCounts = await Promise.all(
        conversationMessages.map((message) => countMessageTokensWithModel(message, model)),
    );
    let keptTokens = 0;
    let splitIndex = conversationMessages.length;

    for (let i = conversationMessages.length - 1; i >= 0; i--) {
        const msgTokens = conversationTokenCounts[i] ?? estimateMessageTokens(conversationMessages[i]);
        if (keptTokens + msgTokens <= availableForConversation * 0.6) { // Keep 60% for recent
            keptTokens += msgTokens;
            splitIndex = i;
        } else {
            break;
        }
    }

    const toSummarize = conversationMessages.slice(0, splitIndex);
    const toKeep = conversationMessages.slice(splitIndex);

    // Generate summary if there's something to summarize
    let summary = '';
    if (toSummarize.length > 0 || existingSummary !== '无') {
        summary = await generateSummary(toSummarize, model, customInstructions, existingSummary);
    }

    // Build new message list
    const summaryMessage = summary ? new SystemMessage(`${SUMMARY_MESSAGE_PREFIX}\n${summary}`) : null;
    const newMessages = [
        ...systemMessages,
        ...(summaryMessage ? [summaryMessage] : []),
        ...toKeep,
    ];

    const tokensAfter = await countTotalTokensWithModel(newMessages, model);

    return {
        messages: newMessages,
        summary,
        tokensBefore,
        tokensAfter,
    };
}
