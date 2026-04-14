import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWebSlashCommand } from './web.js';

test('parseWebSlashCommand defers skill commands to shared skill handler', () => {
    assert.equal(parseWebSlashCommand('/skills'), null);
    assert.equal(parseWebSlashCommand('/skill-install owner/repo'), null);
    assert.equal(parseWebSlashCommand('/skill-remove demo-skill'), null);
    assert.equal(parseWebSlashCommand('/skill-reload'), null);
    assert.equal(parseWebSlashCommand('/mcp'), null);
});

test('parseWebSlashCommand still handles web-native slash commands', () => {
    assert.deepEqual(parseWebSlashCommand('/new'), { type: 'new_session' });
    assert.deepEqual(parseWebSlashCommand('/reset'), { type: 'new_session' });
    assert.deepEqual(parseWebSlashCommand('/status'), { type: 'status' });
    assert.deepEqual(parseWebSlashCommand('/models'), { type: 'list_models' });
    assert.deepEqual(parseWebSlashCommand('/model qwen'), { type: 'switch_model', alias: 'qwen' });
});
