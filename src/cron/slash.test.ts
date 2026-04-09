import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronService } from './service.js';
import { executeCronSlashCommand, parseCronSlashCommand } from './slash.js';
import { setCronService } from './runtime.js';

function createCronService(baseDir: string, name: string): CronService {
    return new CronService({
        enabled: false,
        timezone: 'Asia/Shanghai',
        storePath: join(baseDir, `${name}.json`),
        runLogPath: join(baseDir, `${name}.jsonl`),
        runJob: async () => ({
            status: 'ok',
            summary: 'ok',
        }),
    });
}

test('parseCronSlashCommand recognizes /cron', () => {
    assert.deepEqual(parseCronSlashCommand('/cron'), { type: 'list' });
    assert.equal(parseCronSlashCommand('/status'), null);
});

test('executeCronSlashCommand lists jobs from all registered channels', async (t) => {
    const baseDir = await mkdtemp(join(tmpdir(), 'srebot-cron-slash-'));
    const dingtalk = createCronService(baseDir, 'dingtalk-jobs');
    const ios = createCronService(baseDir, 'ios-jobs');

    await dingtalk.start();
    await ios.start();

    await dingtalk.addJob({
        name: 'DingTalk Job',
        enabled: true,
        schedule: { kind: 'every', every: '1h' },
        payload: { message: 'ping dingtalk' },
        delivery: { channel: 'dingtalk', target: 'cid-team-room' },
    });
    await ios.addJob({
        name: 'iOS Job',
        enabled: true,
        schedule: { kind: 'every', every: '2h' },
        payload: { message: 'ping ios' },
        delivery: { channel: 'ios', target: 'conversation:ios-room' },
    });

    setCronService('dingtalk', dingtalk);
    setCronService('ios', ios);

    t.after(async () => {
        setCronService('dingtalk', null);
        setCronService('ios', null);
        await dingtalk.stop();
        await ios.stop();
        await rm(baseDir, { recursive: true, force: true });
    });

    const result = await executeCronSlashCommand('/cron');
    assert.equal(result.handled, true);
    assert.match(result.response || '', /你当前有 2 个定时任务/);
    assert.match(result.response || '', /1\. /);
    assert.match(result.response || '', /2\. /);
    assert.match(result.response || '', /DingTalk Job/);
    assert.match(result.response || '', /iOS Job/);
    assert.match(result.response || '', /推送渠道: DingTalk/);
    assert.match(result.response || '', /推送渠道: iOS/);
    assert.match(result.response || '', /ID: /);
    assert.match(result.response || '', /调度: /);
    assert.match(result.response || '', /状态: 已启用 ✅/);
    assert.match(result.response || '', /功能: /);
});
