import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { compactMessages, generateSummary } from './summary.js';

function createFakeModel(options?: {
    invoke?: (messages: unknown[]) => Promise<AIMessage>;
    getNumTokens?: (text: string) => Promise<number>;
}): BaseChatModel {
    return {
        invoke: options?.invoke ?? (async () => new AIMessage('## 当前任务\n- 无')),
        getNumTokens: options?.getNumTokens ?? (async (text: string) => Math.ceil(text.length / 4)),
    } as unknown as BaseChatModel;
}

test('generateSummary asks for structured in-progress summary and merges existing summary', async () => {
    let capturedSystemPrompt = '';
    let capturedUserPrompt = '';
    const model = createFakeModel({
        invoke: async (messages: unknown[]) => {
            const typed = messages as Array<{ content: string }>;
            capturedSystemPrompt = typed[0]?.content ?? '';
            capturedUserPrompt = typed[1]?.content ?? '';
            return new AIMessage(`## 当前任务
- 继续排查告警

## 最新用户请求
- 汇总剩余节点检查结果

## 已完成进展
- 已排查 2/5 个节点

## 进行中工作
- 正在检查 node-3 到 node-5

## 待办与后续承诺
- 输出最终排查结论

## 关键决策与约束
- 优先保留节点级进度

## 未解决问题与风险
- 仍需确认 node-4 告警来源`);
        },
    });

    const summary = await generateSummary(
        [new HumanMessage('继续检查 node-3、node-4，并最终汇总。')],
        model,
        '保留节点级进度',
        `## 当前任务
- 排查告警

## 最新用户请求
- 找出根因

## 已完成进展
- 已检查 2/5 个节点

## 进行中工作
- 正在继续后续节点检查

## 待办与后续承诺
- 给出最终总结

## 关键决策与约束
- 不要跳过节点

## 未解决问题与风险
- 根因未确认`,
    );

    assert.match(capturedSystemPrompt, /固定结构/);
    assert.match(capturedSystemPrompt, /进行中工作/);
    assert.match(capturedSystemPrompt, /待办与后续承诺/);
    assert.match(capturedUserPrompt, /【已有摘要】/);
    assert.match(capturedUserPrompt, /已检查 2\/5 个节点/);
    assert.match(capturedUserPrompt, /继续检查 node-3、node-4/);
    assert.match(capturedSystemPrompt, /保留节点级进度/);
    assert.match(summary, /## 进行中工作/);
});

test('compactMessages replaces prior summaries with one merged summary', async () => {
    const model = createFakeModel({
        invoke: async () =>
            new AIMessage(`## 当前任务
- 排查集群告警

## 最新用户请求
- 继续检查剩余节点并输出汇总

## 已完成进展
- 已检查 3/5 个节点

## 进行中工作
- 正在检查 node-4 和 node-5

## 待办与后续承诺
- 汇总根因并给出下一步建议

## 关键决策与约束
- 必须保留节点级进度和告警编号

## 未解决问题与风险
- node-4 仍待确认是否误报`),
        getNumTokens: async (text: string) => text.length,
    });

    const messages = [
        new SystemMessage('你是 Pomelobot。'),
        new SystemMessage(`[对话历史摘要]
## 当前任务
- 排查集群告警

## 最新用户请求
- 找出根因

## 已完成进展
- 已检查 2/5 个节点

## 进行中工作
- 正在继续节点排查

## 待办与后续承诺
- 输出结论

## 关键决策与约束
- 不能漏掉任何节点

## 未解决问题与风险
- 根因未确认`),
        new HumanMessage('继续检查 node-3。'),
        new AIMessage('node-3 已检查，暂无异常。'),
        new HumanMessage('接着检查 node-4、node-5，然后给我一个完整汇总。'),
    ];

    const result = await compactMessages(messages, model, 220);
    const summaryMessages = result.messages.filter((message) => {
        if (message._getType() !== 'system') {
            return false;
        }
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        return content.startsWith('[对话历史摘要]');
    });

    assert.equal(summaryMessages.length, 1);
    assert.match(result.summary, /## 当前任务/);
    assert.match(result.summary, /已检查 3\/5 个节点/);
    assert.match(result.summary, /## 进行中工作/);
    assert.match(result.summary, /node-4 和 node-5/);
    assert.ok(result.tokensAfter < result.tokensBefore);
});
