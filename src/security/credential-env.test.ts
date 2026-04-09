import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    getCredentialEnv,
    readEnvWithCredentialFallback,
    withTemporaryCredentialEnv,
} from './credential-env.js';

test('credential env file is loaded and process env takes priority', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'srebot-cred-env-'));
    const envFile = join(tempDir, '.env');
    const originalPath = process.env.SREBOT_CREDENTIALS_ENV_PATH;
    const originalFromProcess = process.env.TEST_CREDENTIAL_ONLY;

    try {
        await writeFile(envFile, 'TEST_CREDENTIAL_ONLY=from_file\nOPENAI_API_KEY=file_key\n', 'utf-8');
        process.env.SREBOT_CREDENTIALS_ENV_PATH = envFile;

        delete process.env.TEST_CREDENTIAL_ONLY;
        const fromFile = readEnvWithCredentialFallback('TEST_CREDENTIAL_ONLY');
        assert.equal(fromFile, 'from_file');

        process.env.TEST_CREDENTIAL_ONLY = 'from_process';
        const fromProcess = readEnvWithCredentialFallback('TEST_CREDENTIAL_ONLY');
        assert.equal(fromProcess, 'from_process');

        const loaded = getCredentialEnv();
        assert.equal(loaded.OPENAI_API_KEY, 'file_key');
    } finally {
        if (originalPath === undefined) {
            delete process.env.SREBOT_CREDENTIALS_ENV_PATH;
        } else {
            process.env.SREBOT_CREDENTIALS_ENV_PATH = originalPath;
        }
        if (originalFromProcess === undefined) {
            delete process.env.TEST_CREDENTIAL_ONLY;
        } else {
            process.env.TEST_CREDENTIAL_ONLY = originalFromProcess;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('withTemporaryCredentialEnv injects missing vars and restores previous values', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'srebot-cred-inject-'));
    const envFile = join(tempDir, '.env');
    const originalPath = process.env.SREBOT_CREDENTIALS_ENV_PATH;
    const originalToken = process.env.TEST_TEMP_TOKEN;

    try {
        await writeFile(envFile, 'TEST_TEMP_TOKEN=from_file\n', 'utf-8');
        process.env.SREBOT_CREDENTIALS_ENV_PATH = envFile;
        process.env.TEST_TEMP_TOKEN = '';

        await withTemporaryCredentialEnv(async () => {
            assert.equal(process.env.TEST_TEMP_TOKEN, 'from_file');
        });

        assert.equal(process.env.TEST_TEMP_TOKEN, '');
    } finally {
        if (originalPath === undefined) {
            delete process.env.SREBOT_CREDENTIALS_ENV_PATH;
        } else {
            process.env.SREBOT_CREDENTIALS_ENV_PATH = originalPath;
        }
        if (originalToken === undefined) {
            delete process.env.TEST_TEMP_TOKEN;
        } else {
            process.env.TEST_TEMP_TOKEN = originalToken;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});
