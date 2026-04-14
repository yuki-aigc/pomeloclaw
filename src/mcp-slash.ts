import type { MCPRuntimeState } from './mcp.js';

export type MCPSlashCommand = { type: 'list' };

export interface MCPSlashExecutorParams {
    input: string;
    getMCPState: () => MCPRuntimeState | Promise<MCPRuntimeState>;
}

export function parseMCPSlashCommand(input: string): MCPSlashCommand | null {
    const text = input.trim();
    if (text === '/mcp') {
        return { type: 'list' };
    }
    return null;
}

export function getMCPHelpLines(): string[] {
    return [
        '/mcp - 列出当前 MCP 服务器与工具',
    ];
}

export function formatMCPList(state: MCPRuntimeState): string {
    if (state.serverCount === 0) {
        return state.enabled
            ? '当前未配置任何 MCP server。'
            : '当前未启用 MCP，且没有已配置的 server。';
    }

    const lines = [
        '## MCP 列表',
        '',
        `- 全局开关：${state.enabled ? '开启' : '关闭'}`,
        `- Server：${state.loadedServerCount}/${state.serverCount} 已加载`,
        `- Tool：${state.toolCount} 个`,
        '',
    ];

    for (const server of state.servers) {
        const statusParts = [
            server.transport,
            server.enabled ? '已启用' : '已禁用',
            server.loaded ? '已加载' : '未加载',
            `${server.toolCount} 工具`,
        ];
        lines.push(`- \`${server.name}\` (${statusParts.join(' / ')})`);

        if (server.tools.length === 0) {
            continue;
        }

        for (const tool of server.tools) {
            const desc = tool.description ? ` -> ${tool.description}` : '';
            lines.push(`  - \`${tool.name}\`${desc}`);
        }
    }

    return lines.join('\n');
}

export async function executeMCPSlashCommand(params: MCPSlashExecutorParams): Promise<{ handled: boolean; response?: string }> {
    const command = parseMCPSlashCommand(params.input);
    if (!command) {
        return { handled: false };
    }

    const state = await params.getMCPState();
    return {
        handled: true,
        response: formatMCPList(state),
    };
}
