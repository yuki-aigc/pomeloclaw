import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoMemorySaveJobPrompt, resolveDingTalkCronConversationContext } from './dingtalk.js';
import { extractMessageContent } from './channels/dingtalk/handler.js';

test('auto memory save cron prompt uses the shared working summary schema', () => {
    const prompt = buildAutoMemorySaveJobPrompt();

    assert.match(prompt, /每三天一次的记忆归档任务/);
    assert.match(prompt, /最近72小时 \/ 最近三天 \/ 今天 \/ 昨天 \/ 前天/);
    assert.match(prompt, /## 当前任务/);
    assert.match(prompt, /## 最新用户请求/);
    assert.match(prompt, /## 已完成进展/);
    assert.match(prompt, /## 进行中工作/);
    assert.match(prompt, /## 待办与后续承诺/);
    assert.match(prompt, /## 关键决策与约束/);
    assert.match(prompt, /## 未解决问题与风险/);
    assert.match(prompt, /不要包“对话摘要:”前缀/);
    assert.match(prompt, /memory_save/);
    assert.match(prompt, /memory_save_team/);
    assert.match(prompt, /对每一条准备晋升的团队知识，必须先再次调用 memory_search/);
    assert.match(prompt, /检索 main scope 中是否已有相同或高度相近的团队长期记忆/);
    assert.match(prompt, /优先复用已存在条目的标题/);
    assert.match(prompt, /只有在确认 main scope 中没有相近团队记忆时，才允许创建新的长期团队记忆标题/);
    assert.match(prompt, /标准流程|通用排障经验|团队共识/);
    assert.match(prompt, /memory_saved/);
});

test('extractMessageContent maps richText group images into media context input', () => {
    const content = extractMessageContent({
        msgId: 'msg-1',
        msgtype: 'richText',
        createAt: Date.now(),
        content: {
            richText: [
                { type: 'text', text: '帮我看看这张图' },
                { type: 'picture', downloadCode: 'download-code-1' },
            ],
        },
        conversationType: '2',
        conversationId: 'cid-group',
        senderId: 'user-1',
        chatbotUserId: 'bot-1',
        sessionWebhook: 'https://example.com/webhook',
    });

    assert.equal(content.text, '帮我看看这张图');
    assert.equal(content.mediaPath, 'download-code-1');
    assert.equal(content.mediaType, 'image');
    assert.equal(content.messageType, 'richText');
});

test('cron delivery target resolves group context for DingTalk group conversations', () => {
    const context = resolveDingTalkCronConversationContext('cidPfmFRu02/PI80erI27/QaA==');

    assert.equal(context.isDirect, false);
    assert.equal(context.conversationId, 'cidPfmFRu02/PI80erI27/QaA==');
    assert.equal(context.senderId, 'cron');
});

test('cron delivery target resolves direct context for DingTalk private conversations', () => {
    const context = resolveDingTalkCronConversationContext('manager-user-id');

    assert.equal(context.isDirect, true);
    assert.equal(context.conversationId, 'manager-user-id');
    assert.equal(context.senderId, 'manager-user-id');
});
