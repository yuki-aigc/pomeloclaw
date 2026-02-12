import { MultiServerMCPClient, type ClientConfig } from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Config, MCPConfig, MCPServerConfig } from './config.js';

type MCPBootstrapResult = {
    tools: DynamicStructuredTool[];
    close: () => Promise<void>;
    serverNames: string[];
};

function normalizeServerEnv(serverName: string, env?: Record<string, string>): Record<string, string> | undefined {
    if (!env) return undefined;
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        const name = key.trim();
        if (!name) continue;
        if (typeof value !== 'string') {
            throw new Error(`[MCP] Server "${serverName}" env.${name} must be a string`);
        }
        normalized[name] = value;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function expandEnvPlaceholders(value: string, env: Record<string, string | undefined>): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? '');
}

function resolveServerString(value: string | undefined, env: Record<string, string | undefined>): string | undefined {
    if (typeof value !== 'string') return undefined;
    return expandEnvPlaceholders(value, env);
}

function resolveServerHeaders(
    headers: Record<string, string> | undefined,
    env: Record<string, string | undefined>,
): Record<string, string> | undefined {
    if (!headers) return undefined;
    const resolved = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key, expandEnvPlaceholders(value, env)])
    );
    return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function getServerConnectionConfig(serverName: string, server: MCPServerConfig): Record<string, unknown> {
    const scopedEnv = normalizeServerEnv(serverName, server.env);
    const effectiveEnv: Record<string, string | undefined> = {
        ...process.env,
        ...(scopedEnv ?? {}),
    };

    if (server.transport === 'stdio') {
        const command = resolveServerString(server.command, effectiveEnv)?.trim();
        if (!command) {
            throw new Error(`[MCP] Server "${serverName}" is stdio but "command" is empty`);
        }

        return {
            transport: 'stdio',
            command,
            args: (server.args ?? []).map((arg) => expandEnvPlaceholders(arg, effectiveEnv)),
            env: effectiveEnv,
            cwd: resolveServerString(server.cwd, effectiveEnv),
            stderr: server.stderr,
            restart: server.restart,
            defaultToolTimeout: server.defaultToolTimeout,
            outputHandling: server.outputHandling,
        };
    }

    const url = resolveServerString(server.url, effectiveEnv)?.trim();
    if (!url) {
        throw new Error(`[MCP] Server "${serverName}" is ${server.transport} but "url" is empty`);
    }

    return {
        transport: server.transport,
        url,
        headers: resolveServerHeaders(server.headers, effectiveEnv),
        reconnect: server.reconnect,
        automaticSSEFallback: server.automaticSSEFallback,
        defaultToolTimeout: server.defaultToolTimeout,
        outputHandling: server.outputHandling,
    };
}

function getMCPClientConfig(mcpConfig: MCPConfig): ClientConfig {
    const mcpServers: Record<string, Record<string, unknown>> = {};

    for (const [serverName, server] of Object.entries(mcpConfig.servers || {})) {
        if (!serverName.trim()) {
            continue;
        }
        mcpServers[serverName] = getServerConnectionConfig(serverName, server);
    }

    return {
        mcpServers: mcpServers as ClientConfig['mcpServers'],
        throwOnLoadError: mcpConfig.throwOnLoadError ?? true,
        prefixToolNameWithServerName: mcpConfig.prefixToolNameWithServerName ?? true,
        additionalToolNamePrefix: mcpConfig.additionalToolNamePrefix ?? '',
        useStandardContentBlocks: mcpConfig.useStandardContentBlocks ?? false,
        onConnectionError: mcpConfig.onConnectionError ?? 'throw',
    };
}

export async function initializeMCPTools(config: Config): Promise<MCPBootstrapResult> {
    if (!config.mcp?.enabled) {
        return {
            tools: [],
            close: async () => { /* no-op */ },
            serverNames: [],
        };
    }

    const serverNames = Object.keys(config.mcp.servers || {});
    if (serverNames.length === 0) {
        console.warn('[MCP] mcp.enabled=true but no servers configured, skipping MCP initialization.');
        return {
            tools: [],
            close: async () => { /* no-op */ },
            serverNames: [],
        };
    }

    const clientConfig = getMCPClientConfig(config.mcp);
    const client = new MultiServerMCPClient(clientConfig);

    try {
        const tools = await client.getTools();
        console.log(`[MCP] Loaded ${tools.length} tool(s) from ${serverNames.length} server(s).`);
        return {
            tools,
            close: async () => {
                await client.close();
            },
            serverNames,
        };
    } catch (error) {
        try {
            await client.close();
        } catch {
            // Ignore close failures while bubbling up init error.
        }
        throw error;
    }
}
