import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import { DEFAULT_CONFIG } from './config/defaults.js';
import { MCPManager, parseMCPManagementAction } from './mcp-manager.js';
import { buildMCPRuntimeState, type MCPRuntimeState } from './mcp.js';

function createConfig(): Config {
    const config = structuredClone(DEFAULT_CONFIG) as Config;
    config.mcp.enabled = true;
    config.mcp.servers = {
        filesystem: {
            enabled: true,
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
        },
        weather: {
            enabled: false,
            transport: 'sse',
            url: 'https://example.com/mcp/sse',
        },
    };
    return config;
}

function createRuntimeState(config: Config): MCPRuntimeState {
    return buildMCPRuntimeState(config.mcp, {
        serverNames: ['filesystem'],
        toolSummaries: [
            {
                name: 'filesystem_read_file',
                rawName: 'read_file',
                description: 'read file',
                serverName: 'filesystem',
                inputSchema: {
                    type: 'object',
                    required: ['path'],
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Absolute path',
                        },
                        encoding: {
                            type: 'string',
                            enum: ['utf8', 'base64'],
                            default: 'utf8',
                        },
                    },
                },
                parameters: [
                    {
                        name: 'encoding',
                        type: 'string',
                        required: false,
                        default: 'utf8',
                        enum: ['utf8', 'base64'],
                    },
                    {
                        name: 'path',
                        type: 'string',
                        description: 'Absolute path',
                        required: true,
                    },
                ],
            },
        ],
    });
}

test('parseMCPManagementAction accepts server upsert payload', () => {
    const action = parseMCPManagementAction({
        action: 'upsert-server',
        serverName: 'shell-tools',
        server: {
            enabled: true,
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@demo/server'],
        },
    });

    assert.equal(action.action, 'upsert-server');
    assert.equal(action.serverName, 'shell-tools');
    assert.equal(action.server.transport, 'stdio');
});

test('MCPManager toggles server enabled state and reloads agent', async () => {
    const config = createConfig();
    let reloadCount = 0;
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'srebot-mcp-manager-'));
    const configPath = path.join(tempRoot, 'config.json');
    await writeFile(configPath, JSON.stringify({ llm: { default_model: 'x' }, mcp: config.mcp }, null, 2));

    try {
        const manager = new MCPManager({
            config,
            configPath,
            getRuntimeState: () => createRuntimeState(config),
            reloadAgent: async () => {
                reloadCount += 1;
            },
        });

        const state = await manager.execute({
            action: 'set-server-enabled',
            serverName: 'weather',
            enabled: true,
        });

        assert.equal(reloadCount, 1);
        assert.equal(config.mcp.servers.weather?.enabled, true);
        assert.equal(state.enabled, true);

        const persisted = JSON.parse(await readFile(configPath, 'utf8')) as { mcp?: Config['mcp'] };
        assert.equal(persisted.mcp?.servers.weather?.enabled, true);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('MCPManager falls back to config snapshot when runtime state is unavailable', () => {
    const config = createConfig();
    const manager = new MCPManager({
        config,
        getRuntimeState: () => {
            throw new Error('runtime not ready');
        },
        reloadAgent: async () => undefined,
    });

    const state = manager.getState();
    assert.equal(state.serverCount, 2);
    assert.equal(state.loadedServerCount, 0);
    assert.equal(state.toolCount, 0);
    assert.equal(state.servers[0]?.config.transport, 'stdio');
});

test('buildMCPRuntimeState exposes server config and tool parameters', () => {
    const config = createConfig();
    const state = createRuntimeState(config);

    assert.equal(state.servers[0]?.config.transport, 'stdio');
    assert.equal(state.tools[0]?.rawName, 'read_file');
    assert.equal(state.tools[0]?.parameters[0]?.name, 'encoding');
    assert.equal(state.tools[0]?.parameters[1]?.required, true);
});

test('MCPManager restores previous config when reload fails', async () => {
    const config = createConfig();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'srebot-mcp-manager-'));
    const configPath = path.join(tempRoot, 'config.json');
    const originalContent = `${JSON.stringify({ mcp: config.mcp }, null, 2)}\n`;
    await writeFile(configPath, originalContent);

    try {
        const manager = new MCPManager({
            config,
            configPath,
            getRuntimeState: () => createRuntimeState(config),
            reloadAgent: async () => {
                throw new Error('reload failed');
            },
        });

        await assert.rejects(
            manager.execute({
                action: 'set-global-enabled',
                enabled: false,
            }),
            /reload failed/u,
        );

        assert.equal(config.mcp.enabled, true);
        assert.equal(await readFile(configPath, 'utf8'), originalContent);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});
