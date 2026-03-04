import test from 'node:test';
import assert from 'node:assert/strict';
import { withChannelConversationContext } from '../channels/context.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { resolveMemoryScope } from './memory-scope.js';

test('web direct conversations default to shared main scope', async () => {
    const scope = await withChannelConversationContext(
        {
            channel: 'web',
            conversationId: 'wsn_team_shared_12345678',
            isDirect: true,
            senderId: 'user-a',
            senderName: 'User A',
            pendingReplyFiles: [],
        },
        async () => resolveMemoryScope(DEFAULT_CONFIG.agent.memory.session_isolation),
    );

    assert.equal(scope.key, 'main');
    assert.equal(scope.kind, 'main');
});

test('non-web direct conversations still respect direct scope isolation', async () => {
    const scope = await withChannelConversationContext(
        {
            channel: 'dingtalk',
            conversationId: 'cid-team-room',
            isDirect: true,
            senderId: 'user-a',
            senderName: 'User A',
            pendingReplyFiles: [],
        },
        async () => resolveMemoryScope(DEFAULT_CONFIG.agent.memory.session_isolation),
    );

    assert.equal(scope.key, 'direct_user-a');
    assert.equal(scope.kind, 'direct');
});
