import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from './exec.js';
import type { ExecConfig } from '../config.js';

const execConfig: ExecConfig = {
    enabled: true,
    allowedCommands: ['node'],
    deniedCommands: [],
    allowShellOperators: false,
    shellAllowedCommands: [],
    defaultTimeoutMs: 10_000,
    maxOutputLength: 8_000,
    approvals: {
        enabled: false,
    },
};

test('runCommand terminates the child process when abort signal fires', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(new Error('Web request cancelled: req-1')), 100);

    const result = await runCommand(
        `"${process.execPath}" -e "setTimeout(() => {}, 10000)"`,
        execConfig,
        {
            abortSignal: controller.signal,
            timeoutMs: 10_000,
            policyMode: 'enforce',
        },
    );

    assert.equal(result.success, false);
    assert.match(result.error || '', /Web request cancelled: req-1|Command aborted by request cancellation/);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - startedAt < 4_000);
});

test('runCommand returns immediately when abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));

    const result = await runCommand(
        `"${process.execPath}" -e "console.log('should not run')"`,
        execConfig,
        {
            abortSignal: controller.signal,
            policyMode: 'enforce',
        },
    );

    assert.equal(result.success, false);
    assert.equal(result.stdout, '');
    assert.match(result.error || '', /already cancelled/);
});
