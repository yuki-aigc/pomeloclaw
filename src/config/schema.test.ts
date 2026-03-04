import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from './types.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { validateConfig } from './schema.js';

function buildValidConfig(): Config {
    const cloned = structuredClone(DEFAULT_CONFIG) as Config;
    cloned.exec.allowedCommands = ['ls'];
    cloned.exec.deniedCommands = ['rm'];
    cloned.llm.models = cloned.llm.models.map((model, index) => ({
        ...model,
        api_key: index === 0 ? 'sk-test-active' : model.api_key,
    }));
    cloned.llm.default_model = cloned.llm.models[0].alias;
    cloned.llm.active_model_alias = cloned.llm.models[0].alias;
    return cloned;
}

test('validateConfig accepts normalized valid config', () => {
    const config = buildValidConfig();
    const parsed = validateConfig(config);
    assert.equal(parsed.llm.models[0].alias, config.llm.models[0].alias);
});

test('default config keeps non-web direct isolated but web direct shared', () => {
    assert.equal(DEFAULT_CONFIG.agent.memory.session_isolation.direct_scope, 'direct');
    assert.equal(DEFAULT_CONFIG.agent.memory.session_isolation.web_direct_scope, 'main');
});

test('validateConfig reports path for invalid provider', () => {
    const config = buildValidConfig() as unknown as {
        llm: {
            models: Array<{ provider: string }>;
        };
    };
    config.llm.models[0].provider = 'invalid-provider';

    assert.throws(
        () => validateConfig(config as unknown as Config),
        /llm\.models\.0\.provider/
    );
});
