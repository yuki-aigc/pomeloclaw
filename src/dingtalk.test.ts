import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoMemorySaveJobPrompt } from './dingtalk.js';
import { extractMessageContent } from './channels/dingtalk/handler.js';

test('auto memory save cron prompt uses the shared working summary schema', () => {
    const prompt = buildAutoMemorySaveJobPrompt();

    assert.match(prompt, /## 当前任务/);
    assert.match(prompt, /## 最新用户请求/);
    assert.match(prompt, /## 已完成进展/);
    assert.match(prompt, /## 进行中工作/);
    assert.match(prompt, /## 待办与后续承诺/);
    assert.match(prompt, /## 关键决策与约束/);
    assert.match(prompt, /## 未解决问题与风险/);
    assert.match(prompt, /不要包“对话摘要:”前缀/);
    assert.match(prompt, /memory_save/);
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
