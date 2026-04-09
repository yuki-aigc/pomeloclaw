import test from 'node:test';
import assert from 'node:assert/strict';
import { WebConversationCancelRegistry } from './cancel.js';

test('cancel registry marks the active request as cancelled', () => {
    const registry = new WebConversationCancelRegistry();
    registry.start('session-a', 'req-1', undefined, 1000);

    const result = registry.cancel('session-a', 'req-1', 2000);

    assert.equal(result.ok, true);
    assert.equal(result.requestId, 'req-1');
    assert.equal(registry.isCancelled('session-a', 'req-1'), true);
});

test('cancel registry rejects mismatched request ids', () => {
    const registry = new WebConversationCancelRegistry();
    registry.start('session-a', 'req-1', undefined, 1000);

    const result = registry.cancel('session-a', 'req-2', 2000);

    assert.equal(result.ok, false);
    assert.match(result.reason || '', /当前正在执行的请求不是 req-2/);
    assert.equal(registry.isCancelled('session-a', 'req-1'), false);
});

test('cancel registry cancels the active request when request id is omitted', () => {
    const registry = new WebConversationCancelRegistry();
    registry.start('session-a', 'req-1', undefined, 1000);

    const result = registry.cancel('session-a', undefined, 2000);

    assert.equal(result.ok, true);
    assert.equal(result.requestId, 'req-1');
    assert.equal(registry.isCancelled('session-a', 'req-1'), true);
});

test('cancel registry reports already cancelled on repeated requests', () => {
    const registry = new WebConversationCancelRegistry();
    registry.start('session-a', 'req-1', undefined, 1000);

    const first = registry.cancel('session-a', 'req-1', 2000);
    const second = registry.cancel('session-a', 'req-1', 3000);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.alreadyCancelled, true);
    assert.equal(second.requestId, 'req-1');
});

test('finish removes the active execution record', () => {
    const registry = new WebConversationCancelRegistry();
    registry.start('session-a', 'req-1', undefined, 1000);
    registry.cancel('session-a', 'req-1', 2000);

    registry.finish('session-a', 'req-1');

    assert.equal(registry.get('session-a'), null);
});

test('cancel registry aborts the active controller when cancelled', () => {
    const registry = new WebConversationCancelRegistry();
    const controller = new AbortController();
    registry.start('session-a', 'req-1', controller, 1000);

    registry.cancel('session-a', 'req-1', 2000);

    assert.equal(controller.signal.aborted, true);
});
