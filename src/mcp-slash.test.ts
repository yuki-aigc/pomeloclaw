import test from 'node:test';
import assert from 'node:assert/strict';
import { executeMCPSlashCommand, formatMCPList, parseMCPSlashCommand } from './mcp-slash.js';
import type { MCPRuntimeState } from './mcp.js';

function createState(): MCPRuntimeState {
    return {
        enabled: true,
        serverCount: 2,
        loadedServerCount: 1,
        toolCount: 2,
        servers: [
            {
                name: 'filesystem',
                transport: 'stdio',
                config: {
                    transport: 'stdio',
                    command: 'npx',
                    args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
                },
                enabled: true,
                loaded: true,
                toolCount: 2,
                tools: [
                    {
                        name: 'filesystem__read_file',
                        rawName: 'read_file',
                        description: 'Read file',
                        serverName: 'filesystem',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                            },
                        },
                        parameters: [
                            {
                                name: 'path',
                                type: 'string',
                                required: false,
                            },
                        ],
                    },
                    {
                        name: 'filesystem__write_file',
                        rawName: 'write_file',
                        description: 'Write file',
                        serverName: 'filesystem',
                        inputSchema: undefined,
                        parameters: [],
                    },
                ],
            },
            {
                name: 'weather',
                transport: 'sse',
                config: {
                    transport: 'sse',
                    url: 'https://example.com/mcp/sse',
                },
                enabled: false,
                loaded: false,
                toolCount: 0,
                tools: [],
            },
        ],
        tools: [],
    };
}

test('parseMCPSlashCommand recognizes /mcp', () => {
    assert.deepEqual(parseMCPSlashCommand('/mcp'), { type: 'list' });
    assert.equal(parseMCPSlashCommand('/skills'), null);
});

test('formatMCPList renders configured servers and tools', () => {
    const formatted = formatMCPList(createState());
    assert.match(formatted, /## MCP 列表/u);
    assert.match(formatted, /`filesystem`/u);
    assert.match(formatted, /filesystem__read_file/u);
    assert.match(formatted, /`weather`/u);
});

test('executeMCPSlashCommand returns formatted state', async () => {
    const result = await executeMCPSlashCommand({
        input: '/mcp',
        getMCPState: () => createState(),
    });

    assert.equal(result.handled, true);
    assert.match(result.response || '', /MCP 列表/u);
});
