import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildHookTaskCallbackBody,
    buildHookTaskQueryResponse,
    HookTaskManager,
    normalizeAgentHookRequest,
} from './service.js';

function createLogger() {
    return {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    };
}

test('normalizeAgentHookRequest accepts snake_case fields', () => {
    const normalized = normalizeAgentHookRequest({
        request_id: 'req-1',
        session_key: 'alert:host-a',
        prompt: '请分析这条告警',
        payload: { severity: 'critical' },
        metadata: { source: 'alertmanager' },
        callback: {
            url: 'https://example.com/callback',
            token: 'secret',
            headers: {
                'x-source': 'hooks',
            },
        },
    });

    assert.equal(normalized.requestId, 'req-1');
    assert.equal(normalized.sessionKey, 'alert:host-a');
    assert.equal(normalized.prompt, '请分析这条告警');
    assert.deepEqual(normalized.metadata, { source: 'alertmanager' });
    assert.equal(normalized.callback.url, 'https://example.com/callback');
    assert.equal(normalized.callback.token, 'secret');
    assert.deepEqual(normalized.callback.headers, { 'x-source': 'hooks' });
});

test('HookTaskManager accepts task asynchronously and delivers success callback', async () => {
    let resolveTask: ((value: { text: string }) => void) | undefined;
    const fetchCalls: Array<{ url: string; body: unknown }> = [];

    const manager = new HookTaskManager({
        logger: createLogger(),
        executeTask: async () => await new Promise((resolve) => {
            resolveTask = resolve;
        }),
        fetchImpl: async (url, init) => {
            fetchCalls.push({
                url: String(url),
                body: JSON.parse(String(init?.body || '{}')),
            });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
    });

    const accepted = await manager.accept({
        request_id: 'req-async-1',
        session_key: 'alert:service-a',
        prompt: '请输出结论',
        callback: { url: 'https://platform.example.com/hook-callback' },
    });

    assert.equal(accepted.duplicate, false);
    assert.equal(accepted.status, 'accepted');
    assert.equal(fetchCalls.length, 0);

    const taskBeforeFinish = manager.getTask('req-async-1');
    assert.equal(taskBeforeFinish?.status, 'accepted');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const finishTask = resolveTask;
    if (!finishTask) {
        assert.fail('expected detached task resolver to be set');
    }
    finishTask({ text: '分析完成' });
    await manager.waitForIdle();

    const task = manager.getTask('req-async-1');
    assert.equal(task?.status, 'succeeded');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, 'https://platform.example.com/hook-callback');
    assert.equal((fetchCalls[0]?.body as { schema_version?: string }).schema_version, 'v1');
    assert.equal((fetchCalls[0]?.body as { event?: string }).event, 'hook.task.completed');
    assert.equal((fetchCalls[0]?.body as { status?: string }).status, 'succeeded');
    assert.equal((fetchCalls[0]?.body as { result?: { text?: string } }).result?.text, '分析完成');
});

test('HookTaskManager deduplicates request_id and runs only once', async () => {
    let runCount = 0;
    const manager = new HookTaskManager({
        logger: createLogger(),
        executeTask: async () => {
            runCount += 1;
            return { text: 'ok' };
        },
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    const first = await manager.accept({
        request_id: 'req-dedupe-1',
        session_key: 'alert:dedupe',
        prompt: 'first',
        callback: { url: 'https://example.com/callback' },
    });
    const second = await manager.accept({
        request_id: 'req-dedupe-1',
        session_key: 'alert:dedupe',
        prompt: 'second',
        callback: { url: 'https://example.com/callback' },
    });

    await manager.waitForIdle();

    assert.equal(first.task_id, second.task_id);
    assert.equal(second.duplicate, true);
    assert.equal(runCount, 1);
});

test('HookTaskManager marks callback_failed after retry exhaustion', async () => {
    let callbackAttempts = 0;
    const manager = new HookTaskManager({
        logger: createLogger(),
        callbackDefaults: {
            retries: 2,
            retryDelayMs: 1,
        },
        executeTask: async () => ({ text: 'done' }),
        fetchImpl: async () => {
            callbackAttempts += 1;
            return new Response('nope', { status: 500 });
        },
    });

    await manager.accept({
        request_id: 'req-callback-fail',
        session_key: 'alert:callback-fail',
        prompt: 'run',
        callback: { url: 'https://example.com/fail' },
    });
    await manager.waitForIdle();

    const task = manager.getTask('req-callback-fail');
    assert.equal(task?.status, 'callback_failed');
    assert.equal(callbackAttempts, 3);
    assert.equal(task?.callback.attempts, 3);
    assert.equal(task?.callback.delivered, false);
    assert.match(task?.callback.lastError || '', /callback status=500/);
});

test('normalizeAgentHookRequest rejects missing callback', () => {
    assert.throws(
        () => normalizeAgentHookRequest({
            request_id: 'req-invalid',
            session_key: 'alert:invalid',
            prompt: 'hello',
        }),
        /callback 不能为空/
    );
});

test('buildHookTaskQueryResponse exposes callback delivery state without secrets', () => {
    const task = {
        taskId: 'hook_123',
        request: {
            requestId: 'req-123',
            sessionKey: 'alert:svc-a',
            prompt: 'analyze',
            payload: { foo: 'bar' },
            metadata: { source: 'alertmanager' },
            callback: {
                url: 'https://platform.example.com/callback',
                token: 'secret',
            },
        },
        status: 'succeeded' as const,
        acceptedAt: Date.parse('2026-04-03T01:00:00.000Z'),
        startedAt: Date.parse('2026-04-03T01:00:01.000Z'),
        finishedAt: Date.parse('2026-04-03T01:00:02.000Z'),
        result: {
            text: 'done',
            metadata: { scopeKey: 'direct_hook_x' },
        },
        callback: {
            url: 'https://platform.example.com/callback',
            timeoutMs: 5000,
            maxRetries: 2,
            retryDelayMs: 1000,
            attempts: 1,
            delivered: true,
            lastAttemptAt: Date.parse('2026-04-03T01:00:02.100Z'),
            deliveredAt: Date.parse('2026-04-03T01:00:02.200Z'),
        },
    };

    const response = buildHookTaskQueryResponse(task);
    assert.equal(response.task.task_id, 'hook_123');
    assert.equal(response.task.callback.url, 'https://platform.example.com/callback');
    assert.equal(response.task.callback.delivered, true);
    assert.equal('token' in response.task.callback, false);
});

test('buildHookTaskCallbackBody uses stable platform contract', () => {
    const task = {
        taskId: 'hook_456',
        request: {
            requestId: 'req-456',
            sessionKey: 'alert:svc-b',
            prompt: 'analyze',
            metadata: { source: 'grafana' },
            callback: {
                url: 'https://platform.example.com/callback',
            },
        },
        status: 'failed' as const,
        acceptedAt: Date.parse('2026-04-03T01:00:00.000Z'),
        startedAt: Date.parse('2026-04-03T01:00:01.000Z'),
        finishedAt: Date.parse('2026-04-03T01:00:02.000Z'),
        error: 'model failed',
        callback: {
            url: 'https://platform.example.com/callback',
            timeoutMs: 5000,
            maxRetries: 2,
            retryDelayMs: 1000,
            attempts: 1,
            delivered: false,
        },
    };

    const body = buildHookTaskCallbackBody(task);
    assert.equal(body.schema_version, 'v1');
    assert.equal(body.event, 'hook.task.completed');
    assert.equal(body.status, 'failed');
    assert.equal(body.error?.message, 'model failed');
    assert.equal(body.metadata?.source, 'grafana');
});
