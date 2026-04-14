import { MultiServerMCPClient, type ClientConfig } from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Config, MCPConfig, MCPServerConfig } from './config.js';
import { buildEnvWithCredentialFallback } from './security/credential-env.js';

export interface MCPToolParameterSummary {
    name: string;
    type: string;
    description?: string;
    required: boolean;
    default?: unknown;
    enum?: unknown[];
}

export interface MCPToolSummary {
    name: string;
    description: string;
    serverName?: string;
    rawName?: string;
    inputSchema?: Record<string, unknown>;
    parameters: MCPToolParameterSummary[];
}

export interface MCPServerRuntimeState {
    name: string;
    transport: MCPServerConfig['transport'];
    config: MCPServerConfig;
    enabled: boolean;
    loaded: boolean;
    toolCount: number;
    tools: MCPToolSummary[];
}

export interface MCPRuntimeState {
    enabled: boolean;
    serverCount: number;
    loadedServerCount: number;
    toolCount: number;
    servers: MCPServerRuntimeState[];
    tools: MCPToolSummary[];
}

type MCPBootstrapResult = {
    tools: DynamicStructuredTool[];
    close: () => Promise<void>;
    serverNames: string[];
    toolSummaries: MCPToolSummary[];
};

function toSingleLineDescription(description: string | undefined): string {
    if (!description) return '';
    return description.replace(/\s+/g, ' ').trim();
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

function getSchemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
    const properties = asPlainObject(schema.properties);
    return properties ?? {};
}

function getSchemaRequired(schema: Record<string, unknown>): Set<string> {
    const required = Array.isArray(schema.required) ? schema.required : [];
    return new Set(
        required
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim()),
    );
}

function normalizeParameterType(value: unknown): string {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    if (Array.isArray(value)) {
        const parts = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
        if (parts.length > 0) {
            return parts.join(' | ');
        }
    }
    return 'unknown';
}

function extractToolParameters(schema: unknown): MCPToolParameterSummary[] {
    const schemaObject = asPlainObject(schema);
    if (!schemaObject) {
        return [];
    }

    const properties = getSchemaProperties(schemaObject);
    const required = getSchemaRequired(schemaObject);

    return Object.entries(properties)
        .map(([name, value]) => {
            const property = asPlainObject(value) ?? {};
            const enumValues = Array.isArray(property.enum) ? [...property.enum] : undefined;
            return {
                name,
                type: normalizeParameterType(property.type),
                description: typeof property.description === 'string' ? property.description.trim() || undefined : undefined,
                required: required.has(name),
                default: property.default,
                enum: enumValues,
            } satisfies MCPToolParameterSummary;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function isMCPServerEnabled(server: MCPServerConfig): boolean {
    return server.enabled ?? true;
}

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
    const processEnvWithCredentials = buildEnvWithCredentialFallback(process.env);
    const effectiveEnv: Record<string, string | undefined> = {
        ...processEnvWithCredentials,
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
        if (!isMCPServerEnabled(server)) {
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

function inferToolServerName(toolName: string, mcpConfig: MCPConfig, serverNames: string[]): string | undefined {
    if (!(mcpConfig.prefixToolNameWithServerName ?? true)) {
        return undefined;
    }

    const prefix = mcpConfig.additionalToolNamePrefix ?? '';
    for (const serverName of serverNames) {
        const expectedPrefix = prefix ? `${prefix}__${serverName}__` : `${serverName}__`;
        const fallbackPrefix = `${prefix}${serverName}_`;
        if (toolName.startsWith(expectedPrefix)) {
            return serverName;
        }
        if (toolName.startsWith(fallbackPrefix)) {
            return serverName;
        }
    }
    return undefined;
}

function inferRawToolName(toolName: string, serverName: string | undefined, mcpConfig: MCPConfig): string {
    if (!serverName || !(mcpConfig.prefixToolNameWithServerName ?? true)) {
        return toolName;
    }

    const prefix = mcpConfig.additionalToolNamePrefix ?? '';
    const standardPrefix = prefix ? `${prefix}__${serverName}__` : `${serverName}__`;
    if (toolName.startsWith(standardPrefix)) {
        return toolName.slice(standardPrefix.length);
    }

    const fallbackPrefix = `${prefix}${serverName}_`;
    if (toolName.startsWith(fallbackPrefix)) {
        return toolName.slice(fallbackPrefix.length);
    }

    return toolName;
}

function buildToolSummaries(
    tools: DynamicStructuredTool[],
    mcpConfig: MCPConfig,
    serverNames: string[],
): MCPToolSummary[] {
    return [...tools]
        .map((tool) => {
            const serverName = inferToolServerName(tool.name, mcpConfig, serverNames);
            const inputSchema = asPlainObject(tool.schema) ? structuredClone(tool.schema as Record<string, unknown>) : undefined;
            return {
                name: tool.name,
                rawName: inferRawToolName(tool.name, serverName, mcpConfig),
                description: toSingleLineDescription(tool.description),
                serverName,
                inputSchema,
                parameters: extractToolParameters(inputSchema),
            } satisfies MCPToolSummary;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildMCPRuntimeState(
    mcpConfig: MCPConfig,
    bootstrap?: Pick<MCPBootstrapResult, 'serverNames' | 'toolSummaries'>,
): MCPRuntimeState {
    const toolSummaries = [...(bootstrap?.toolSummaries ?? [])];
    const loadedServerNames = new Set(bootstrap?.serverNames ?? []);

    const servers = Object.entries(mcpConfig.servers || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, server]) => {
            const tools = toolSummaries.filter((tool) => tool.serverName === name);
            return {
                name,
                transport: server.transport,
                config: structuredClone(server),
                enabled: Boolean(mcpConfig.enabled && isMCPServerEnabled(server)),
                loaded: loadedServerNames.has(name),
                toolCount: tools.length,
                tools,
            } satisfies MCPServerRuntimeState;
        });

    return {
        enabled: mcpConfig.enabled,
        serverCount: servers.length,
        loadedServerCount: servers.filter((server) => server.loaded).length,
        toolCount: toolSummaries.length,
        servers,
        tools: toolSummaries,
    };
}

export async function initializeMCPTools(config: Config): Promise<MCPBootstrapResult> {
    if (!config.mcp?.enabled) {
        return {
            tools: [],
            close: async () => { /* no-op */ },
            serverNames: [],
            toolSummaries: [],
        };
    }

    const serverNames = Object.entries(config.mcp.servers || {})
        .filter(([, server]) => isMCPServerEnabled(server))
        .map(([serverName]) => serverName);
    if (serverNames.length === 0) {
        console.warn('[MCP] mcp.enabled=true but no enabled servers configured, skipping MCP initialization.');
        return {
            tools: [],
            close: async () => { /* no-op */ },
            serverNames: [],
            toolSummaries: [],
        };
    }

    const clientConfig = getMCPClientConfig(config.mcp);
    const client = new MultiServerMCPClient(clientConfig);

    try {
        const tools = await client.getTools();
        const toolSummaries = buildToolSummaries(tools, config.mcp, serverNames);
        console.log(`[MCP] Loaded ${tools.length} tool(s) from ${serverNames.length} server(s).`);
        return {
            tools,
            close: async () => {
                await client.close();
            },
            serverNames,
            toolSummaries,
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
