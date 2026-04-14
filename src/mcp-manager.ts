import { z } from 'zod';
import { join } from 'node:path';
import type { Config, MCPConfig, MCPServerConfig } from './config.js';
import { mcpServerSchema } from './config/schema.js';
import { readConfigFileSnapshot, restoreConfigFileSnapshot, writeMCPConfigSection } from './config/persist.js';
import { buildMCPRuntimeState, type MCPRuntimeState } from './mcp.js';

const SERVER_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/u;

const serverNameSchema = z.string().trim().regex(SERVER_NAME_RE, 'serverName 非法：仅允许字母、数字、点、下划线、中划线');

const mcpActionSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('reload'),
    }),
    z.object({
        action: z.literal('set-global-enabled'),
        enabled: z.boolean(),
    }),
    z.object({
        action: z.literal('set-server-enabled'),
        serverName: serverNameSchema,
        enabled: z.boolean(),
    }),
    z.object({
        action: z.literal('upsert-server'),
        serverName: serverNameSchema,
        server: mcpServerSchema,
    }),
    z.object({
        action: z.literal('remove-server'),
        serverName: serverNameSchema,
    }),
]);

export type MCPManagementAction = z.infer<typeof mcpActionSchema>;

export function parseMCPManagementAction(input: unknown): MCPManagementAction {
    const parsed = mcpActionSchema.safeParse(input);
    if (parsed.success) {
        return parsed.data;
    }

    const issue = parsed.error.issues[0];
    throw new Error(issue?.message || 'MCP 请求参数不合法');
}

export interface MCPManagerOptions {
    config: Config;
    configPath?: string;
    reloadAgent: () => Promise<void>;
    getRuntimeState: () => MCPRuntimeState;
}

export class MCPManager {
    constructor(private readonly options: MCPManagerOptions) {}

    getState(): MCPRuntimeState {
        try {
            return this.options.getRuntimeState();
        } catch {
            return buildMCPRuntimeState(this.options.config.mcp);
        }
    }

    async execute(action: MCPManagementAction): Promise<MCPRuntimeState> {
        if (action.action === 'reload') {
            await this.options.reloadAgent();
            return this.getState();
        }

        return this.mutate(async (mcpConfig) => {
            if (action.action === 'set-global-enabled') {
                mcpConfig.enabled = action.enabled;
                return;
            }

            if (action.action === 'set-server-enabled') {
                const server = this.requireServer(mcpConfig, action.serverName);
                server.enabled = action.enabled;
                if (action.enabled) {
                    mcpConfig.enabled = true;
                }
                return;
            }

            if (action.action === 'upsert-server') {
                mcpConfig.servers[action.serverName] = structuredClone(action.server) as MCPServerConfig;
                mcpConfig.enabled = true;
                return;
            }

            delete mcpConfig.servers[action.serverName];
        });
    }

    private requireServer(mcpConfig: MCPConfig, serverName: string): MCPServerConfig {
        const server = mcpConfig.servers[serverName];
        if (!server) {
            throw new Error(`未找到 MCP server: ${serverName}`);
        }
        return server;
    }

    private async mutate(mutator: (mcpConfig: MCPConfig) => Promise<void> | void): Promise<MCPRuntimeState> {
        const previousMCP = structuredClone(this.options.config.mcp);
        const configPath = this.options.configPath || join(process.cwd(), 'config.json');
        const fileSnapshot = await readConfigFileSnapshot(configPath);

        try {
            await mutator(this.options.config.mcp);
            await writeMCPConfigSection(configPath, this.options.config.mcp);
            await this.options.reloadAgent();
            return this.getState();
        } catch (error) {
            this.options.config.mcp = previousMCP;
            await restoreConfigFileSnapshot(configPath, fileSnapshot).catch(() => undefined);
            throw error;
        }
    }
}
