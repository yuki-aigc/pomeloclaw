import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoMemorySaveJobPrompt } from './dingtalk.js';

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
