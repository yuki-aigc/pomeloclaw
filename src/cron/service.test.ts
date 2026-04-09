import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { CronService } from './service.js';
import type { CronRunResult } from './types.js';

test('CronService.triggerJobNow starts manual run in background and updates state after completion', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'srebot-cron-service-'));
    let resolveRun: ((result: CronRunResult) => void) | null = null;
    let runCount = 0;

    const service = new CronService({
        enabled: false,
        timezone: 'Asia/Shanghai',
        storePath: path.join(tempDir, 'jobs.json'),
        logger: {},
        runJob: async () => {
            runCount += 1;
            return await new Promise<CronRunResult>((resolve) => {
                resolveRun = resolve;
            });
        },
    });

    await service.start();
    const job = await service.addJob({
        name: 'manual background test',
        schedule: { kind: 'every', every: '1h' },
        payload: { message: 'run in background' },
    });

    const started = await service.triggerJobNow(job.id);
    assert.equal(started.id, job.id);
    assert.equal(runCount, 0);

    const runningJob = await service.getJob(job.id);
    assert.ok(runningJob);
    assert.equal(typeof runningJob?.state.runningAtMs, 'number');
    assert.equal(runningJob?.state.lastStatus, undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runCount, 1);
    const completeRun = resolveRun as ((result: CronRunResult) => void) | null;
    if (!completeRun) {
        assert.fail('expected background resolver to be set');
    }
    completeRun({ status: 'ok', summary: 'done' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const finishedJob = await service.getJob(job.id);
    assert.ok(finishedJob);
    assert.equal(finishedJob?.state.runningAtMs, undefined);
    assert.equal(finishedJob?.state.lastStatus, 'ok');
    assert.equal(finishedJob?.state.lastError, undefined);
});
