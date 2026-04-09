import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCommandRisk, checkCommandPolicy } from './exec-policy.js';
import type { ExecConfig } from '../config.js';

const config: ExecConfig = {
    enabled: true,
    allowedCommands: ['python', 'python3', 'echo', 'curl'],
    deniedCommands: ['rm'],
    defaultTimeoutMs: 30000,
    maxOutputLength: 50000,
    approvals: {
        enabled: false,
    },
};

test('allows pipe and ampersand tokens through policy checks', () => {
    const pipeRisk = assessCommandRisk('echo hello | head -1');
    const andRisk = assessCommandRisk('echo hello && echo world');

    assert.equal(pipeRisk.blocked, false);
    assert.equal(andRisk.blocked, false);
});

test('does not treat quoted python semicolons as shell chaining', () => {
    const command = 'python -c "import sys; print(sys.version)"';
    const risk = assessCommandRisk(command);
    const policy = checkCommandPolicy(command, config);

    assert.equal(risk.blocked, false);
    assert.equal(risk.reasons.includes('Semicolon chaining is not allowed'), false);
    assert.equal(policy.status, 'allowed');
});

test('allows multiline python -c scripts in quoted arguments', () => {
    const command = `python3 -c "
from scripts.apm import APMClient, analyze_alert
from dotenv import load_dotenv

print('ok')
"`;
    const risk = assessCommandRisk(command);
    const policy = checkCommandPolicy(command, config);

    assert.equal(risk.blocked, false);
    assert.equal(policy.status, 'allowed');
});

test('still blocks unquoted shell semicolons', () => {
    const command = 'echo hello; echo world';
    const risk = assessCommandRisk(command);
    const policy = checkCommandPolicy(command, config);

    assert.equal(risk.blocked, true);
    assert.equal(risk.reasons.includes('Semicolon chaining is not allowed'), true);
    assert.equal(policy.status, 'denied');
});

test('still blocks unquoted redirection operators', () => {
    const command = 'echo hello > out.txt';
    const risk = assessCommandRisk(command);
    const policy = checkCommandPolicy(command, config);

    assert.equal(risk.blocked, true);
    assert.equal(risk.reasons.includes('Redirection operators are not allowed'), true);
    assert.equal(policy.status, 'denied');
});

test('still blocks NUL bytes in command input', () => {
    const command = 'python -c "print(1)\0"';
    const risk = assessCommandRisk(command);
    const policy = checkCommandPolicy(command, config);

    assert.equal(risk.blocked, true);
    assert.equal(risk.reasons.includes('NUL bytes are not allowed in command input'), true);
    assert.equal(policy.status, 'denied');
});
