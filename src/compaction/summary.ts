import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { estimateMessageTokens } from './compaction.js';

const SUMMARY_SYSTEM_PROMPT = `你是一个对话摘要助手。请将以下对话历史压缩成简洁的摘要，保留：
1. 关键决策和结论
2. 重要的待办事项
3. 用户的偏好和约束
4. 未解决的问题

摘要应该简洁但信息完整，便于后续对话继续。使用中文回复。`;

const SUMMARY_USER_TEMPLATE = `请总结以下对话历史：

{messages}

请生成简洁的摘要：`;

/**
 * Generate a summary of messages using LLM
 */
export async function generateSummary(
    messages: BaseMessage[],
    model: BaseChatModel,
    customInstructions?: string,
): Promise<string> {
    if (messages.length === 0) {
        return '无历史对话。';
    }

    // Format messages for summarization
    const formattedMessages = messages.map(msg => {
        const role = msg._getType() === 'human' ? '用户' :
            msg._getType() === 'ai' ? '助手' :
                msg._getType() === 'system' ? '系统' : '其他';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return `[${role}]: ${content}`;
    }).join('\n\n');

    const systemPrompt = customInstructions
        ? `${SUMMARY_SYSTEM_PROMPT}\n\n额外要求：${customInstructions}`
        : SUMMARY_SYSTEM_PROMPT;

    const userPrompt = SUMMARY_USER_TEMPLATE.replace('{messages}', formattedMessages);

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
    const tokensBefore = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

    if (tokensBefore <= maxTokens) {
        return {
            messages,
            summary: '',
            tokensBefore,
            tokensAfter: tokensBefore,
        };
    }

    // Separate system messages and conversational messages
    const systemMessages = messages.filter(m => m._getType() === 'system');
    const conversationMessages = messages.filter(m => m._getType() !== 'system');

    // Calculate how many tokens we can use for conversation
    const systemTokens = systemMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const availableForConversation = maxTokens - systemTokens - 500; // Reserve 500 for summary

    // Find the split point - keep recent messages within budget
    let keptTokens = 0;
    let splitIndex = conversationMessages.length;

    for (let i = conversationMessages.length - 1; i >= 0; i--) {
        const msgTokens = estimateMessageTokens(conversationMessages[i]);
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
    if (toSummarize.length > 0) {
        summary = await generateSummary(toSummarize, model, customInstructions);
    }

    // Build new message list
    const summaryMessage = summary ? new SystemMessage(`[对话历史摘要]\n${summary}`) : null;
    const newMessages = [
        ...systemMessages,
        ...(summaryMessage ? [summaryMessage] : []),
        ...toKeep,
    ];

    const tokensAfter = newMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

    return {
        messages: newMessages,
        summary,
        tokensBefore,
        tokensAfter,
    };
}
