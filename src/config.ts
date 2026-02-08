import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface OpenAIConfig {
    base_url: string;
    model: string;
    api_key: string;
    max_retries?: number;
}

export interface AnthropicConfig {
    base_url: string;
    model: string;
    api_key: string;
    max_retries?: number;
}

export type LLMProvider = 'openai' | 'anthropic';

export interface LLMModelConfig {
    alias: string;
    provider: LLMProvider;
    base_url: string;
    model: string;
    api_key: string;
    headers?: Record<string, string>;
    max_retries?: number;
}

export interface LLMConfig {
    default_model: string;
    active_model_alias: string;
    models: LLMModelConfig[];
}

export interface CompactionConfig {
    enabled: boolean;
    auto_compact_threshold: number;
    context_window: number;
    reserve_tokens: number;
    max_history_share: number;
}

export interface AgentConfig {
    workspace: string;
    skills_dir: string;
    recursion_limit: number;
    compaction: CompactionConfig;
}

export interface ExecCommandsFile {
    allowedCommands: string[];
    deniedCommands: string[];
}

export interface ExecApprovalsConfig {
    enabled: boolean;
}

export interface ExecConfigFile {
    enabled: boolean;
    commandsFile?: string;
    allowedCommands?: string[];
    deniedCommands?: string[];
    defaultTimeoutMs: number;
    maxOutputLength: number;
    approvals?: Partial<ExecApprovalsConfig>;
}

export interface ExecConfig {
    enabled: boolean;
    allowedCommands: string[];
    deniedCommands: string[];
    defaultTimeoutMs: number;
    maxOutputLength: number;
    approvals: ExecApprovalsConfig;
}

export type MCPOutputHandling =
    | 'content'
    | 'artifact'
    | {
        text?: 'content' | 'artifact';
        image?: 'content' | 'artifact';
        audio?: 'content' | 'artifact';
        resource?: 'content' | 'artifact';
        resource_link?: 'content' | 'artifact';
    };

export interface MCPServerBaseConfig {
    defaultToolTimeout?: number;
    outputHandling?: MCPOutputHandling;
}

export interface MCPServerStdioConfig extends MCPServerBaseConfig {
    transport: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stderr?: 'overlapped' | 'pipe' | 'ignore' | 'inherit';
    restart?: {
        enabled?: boolean;
        maxAttempts?: number;
        delayMs?: number;
    };
}

export interface MCPServerHttpConfig extends MCPServerBaseConfig {
    transport: 'http' | 'sse';
    url: string;
    headers?: Record<string, string>;
    reconnect?: {
        enabled?: boolean;
        maxAttempts?: number;
        delayMs?: number;
    };
    automaticSSEFallback?: boolean;
}

export type MCPServerConfig = MCPServerStdioConfig | MCPServerHttpConfig;

export interface MCPConfig {
    enabled: boolean;
    throwOnLoadError?: boolean;
    prefixToolNameWithServerName?: boolean;
    additionalToolNamePrefix?: string;
    useStandardContentBlocks?: boolean;
    onConnectionError?: 'throw' | 'ignore';
    servers: Record<string, MCPServerConfig>;
}

export interface DingTalkConfig {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    robotCode?: string;
    corpId?: string;
    agentId?: string;
    messageType?: 'markdown' | 'card';
    cardTemplateId?: string;
    showThinking?: boolean;
    debug?: boolean;
    execApprovals?: {
        enabled?: boolean;
        timeoutMs?: number;
        mode?: 'text' | 'button';
        templateId?: string;
    };
    voice?: {
        enabled?: boolean;
        requireRecognition?: boolean;
        prependRecognitionHint?: boolean;
    };
    cron?: {
        defaultTarget?: string;
        useMarkdown?: boolean;
        title?: string;
    };
}

export interface CronConfig {
    enabled: boolean;
    store: string;
    timezone?: string;
    runLog?: string;
}

export interface Config {
    llm: LLMConfig;
    agent: AgentConfig;
    exec: ExecConfig;
    mcp: MCPConfig;
    cron: CronConfig;
    dingtalk?: DingTalkConfig;
}

const DEFAULT_COMMANDS: ExecCommandsFile = {
    allowedCommands: [
        'ls', 'cat', 'head', 'tail', 'grep', 'find', 'pwd', 'echo',
        'date', 'whoami', 'df', 'uptime', 'ps',
    ],
    deniedCommands: ['rm', 'mv', 'cp', 'chmod', 'chown', 'sudo', 'su'],
};

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const DEFAULT_CONFIG = {
    llm: {
        default_model: 'default_model',
        active_model_alias: 'default_model',
        models: [
            {
                alias: 'default_model',
                provider: 'openai' as const,
                base_url: 'https://api.openai.com/v1',
                model: 'gpt-4o',
                api_key: '',
                max_retries: 3,
            },
            {
                alias: 'claude35',
                provider: 'anthropic' as const,
                base_url: 'https://api.anthropic.com',
                model: 'claude-3-5-sonnet-latest',
                api_key: '',
                max_retries: 3,
            },
        ] as LLMModelConfig[],
    },
    agent: {
        workspace: './workspace',
        skills_dir: './workspace/skills',
        recursion_limit: 100,
        compaction: {
            enabled: true,
            auto_compact_threshold: 80000,
            context_window: 128000,
            reserve_tokens: 20000,
            max_history_share: 0.5,
        },
    },
    exec: {
        enabled: true,
        defaultTimeoutMs: 30000,
        maxOutputLength: 50000,
        approvals: {
            enabled: false,
        },
    },
    mcp: {
        enabled: false,
        throwOnLoadError: true,
        prefixToolNameWithServerName: true,
        additionalToolNamePrefix: '',
        useStandardContentBlocks: false,
        onConnectionError: 'throw' as const,
        servers: {},
    },
    cron: {
        enabled: true,
        store: './workspace/cron/jobs.json',
        timezone: DEFAULT_TIMEZONE,
        runLog: './workspace/cron/runs.jsonl',
    },
};

/**
 * Load exec commands from a separate file or use inline config
 */
function loadExecCommands(execConfig: ExecConfigFile): ExecCommandsFile {
    if (execConfig.commandsFile) {
        const commandsPath = resolve(process.cwd(), execConfig.commandsFile);
        if (existsSync(commandsPath)) {
            try {
                const content = readFileSync(commandsPath, 'utf-8');
                const commands = JSON.parse(content) as ExecCommandsFile;
                console.log(`[Config] Loaded exec commands from ${execConfig.commandsFile}`);
                return {
                    allowedCommands: commands.allowedCommands || DEFAULT_COMMANDS.allowedCommands,
                    deniedCommands: commands.deniedCommands || DEFAULT_COMMANDS.deniedCommands,
                };
            } catch (error) {
                console.warn(`Warning: Failed to parse ${execConfig.commandsFile}, using defaults`);
            }
        } else {
            console.warn(`Warning: Commands file ${execConfig.commandsFile} not found, using defaults`);
        }
    }

    return {
        allowedCommands: execConfig.allowedCommands || DEFAULT_COMMANDS.allowedCommands,
        deniedCommands: execConfig.deniedCommands || DEFAULT_COMMANDS.deniedCommands,
    };
}

export function loadConfig(): Config {
    const configPath = join(process.cwd(), 'config.json');

    let fileConfig: {
        llm?: {
            default_model?: string;
            active_model_alias?: string;
            models?: Array<Partial<LLMModelConfig> & { alias?: string; provider?: LLMProvider }>
            | Record<string, Partial<LLMModelConfig> & { provider?: LLMProvider }>;
        };
        openai?: Partial<OpenAIConfig>;
        anthropic?: Partial<AnthropicConfig>;
        agent?: Partial<AgentConfig> & { compaction?: Partial<CompactionConfig> };
        exec?: ExecConfigFile;
        mcp?: Partial<MCPConfig>;
        cron?: Partial<CronConfig>;
        dingtalk?: DingTalkConfig;
    } = {};

    if (existsSync(configPath)) {
        try {
            const content = readFileSync(configPath, 'utf-8');
            fileConfig = JSON.parse(content);
        } catch (error) {
            console.warn('Warning: Failed to parse config.json, using defaults');
        }
    }

    const execCommands = loadExecCommands(fileConfig.exec || { enabled: true, defaultTimeoutMs: 30000, maxOutputLength: 50000 });

    const legacyOpenAI: OpenAIConfig = {
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        api_key: '',
        max_retries: 3,
        ...fileConfig.openai,
    };
    const legacyAnthropic: AnthropicConfig = {
        base_url: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-latest',
        api_key: '',
        max_retries: 3,
        ...fileConfig.anthropic,
    };

    const defaultModelsFromLegacy: LLMModelConfig[] = [
        {
            alias: 'default_model',
            provider: 'openai',
            base_url: legacyOpenAI.base_url,
            model: legacyOpenAI.model,
            api_key: legacyOpenAI.api_key,
            max_retries: legacyOpenAI.max_retries ?? 3,
        },
        {
            alias: 'claude35',
            provider: 'anthropic',
            base_url: legacyAnthropic.base_url,
            model: legacyAnthropic.model,
            api_key: legacyAnthropic.api_key,
            max_retries: legacyAnthropic.max_retries ?? 3,
        },
    ];

    const config: Config = {
        llm: {
            default_model: fileConfig.llm?.default_model
                ?? fileConfig.llm?.active_model_alias
                ?? DEFAULT_CONFIG.llm.default_model,
            active_model_alias: fileConfig.llm?.default_model
                ?? fileConfig.llm?.active_model_alias
                ?? DEFAULT_CONFIG.llm.active_model_alias,
            models: [...defaultModelsFromLegacy],
        },
        agent: {
            ...DEFAULT_CONFIG.agent,
            ...fileConfig.agent,
            compaction: {
                ...DEFAULT_CONFIG.agent.compaction,
                ...(fileConfig.agent?.compaction || {}),
            },
        },
        exec: {
            enabled: fileConfig.exec?.enabled ?? DEFAULT_CONFIG.exec.enabled,
            allowedCommands: execCommands.allowedCommands,
            deniedCommands: execCommands.deniedCommands,
            defaultTimeoutMs: fileConfig.exec?.defaultTimeoutMs ?? DEFAULT_CONFIG.exec.defaultTimeoutMs,
            maxOutputLength: fileConfig.exec?.maxOutputLength ?? DEFAULT_CONFIG.exec.maxOutputLength,
            approvals: {
                enabled: fileConfig.exec?.approvals?.enabled ?? DEFAULT_CONFIG.exec.approvals.enabled,
            },
        },
        mcp: {
            ...DEFAULT_CONFIG.mcp,
            ...fileConfig.mcp,
            servers: fileConfig.mcp?.servers || DEFAULT_CONFIG.mcp.servers,
        },
        cron: {
            ...DEFAULT_CONFIG.cron,
            ...fileConfig.cron,
            store: fileConfig.cron?.store || DEFAULT_CONFIG.cron.store,
            runLog: fileConfig.cron?.runLog || DEFAULT_CONFIG.cron.runLog,
            timezone: fileConfig.cron?.timezone || DEFAULT_CONFIG.cron.timezone,
        },
        dingtalk: fileConfig.dingtalk,
    };

    const pushModel = (list: LLMModelConfig[], model: LLMModelConfig): void => {
        const alias = model.alias.trim();
        if (!alias) return;
        const idx = list.findIndex((item) => item.alias === alias);
        if (idx >= 0) {
            list[idx] = { ...model, alias };
        } else {
            list.push({ ...model, alias });
        }
    };

    const normalizeModel = (
        raw: Partial<LLMModelConfig> & { alias?: string; provider?: LLMProvider },
        aliasFallback?: string,
    ): LLMModelConfig | null => {
        const alias = (raw.alias ?? aliasFallback ?? '').trim();
        if (!alias) return null;

        const provider = raw.provider;
        if (provider !== 'openai' && provider !== 'anthropic') {
            return null;
        }

        let headers: Record<string, string> | undefined;
        if (raw.headers !== undefined) {
            if (!raw.headers || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) {
                return null;
            }
            const normalizedHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(raw.headers)) {
                if (typeof value !== 'string') {
                    return null;
                }
                const headerName = key.trim();
                if (!headerName) continue;
                normalizedHeaders[headerName] = value;
            }
            if (Object.keys(normalizedHeaders).length > 0) {
                headers = normalizedHeaders;
            }
        }

        const fallback = provider === 'openai' ? legacyOpenAI : legacyAnthropic;
        return {
            alias,
            provider,
            base_url: raw.base_url ?? fallback.base_url,
            model: raw.model ?? fallback.model,
            api_key: raw.api_key ?? fallback.api_key,
            headers,
            max_retries: raw.max_retries ?? fallback.max_retries ?? 3,
        };
    };

    const parsedModels: LLMModelConfig[] = [];
    const rawModels = fileConfig.llm?.models;
    if (Array.isArray(rawModels)) {
        for (const raw of rawModels) {
            const normalized = normalizeModel(raw);
            if (!normalized) {
                console.warn('Warning: Invalid llm.models item, skipping');
                continue;
            }
            pushModel(parsedModels, normalized);
        }
    } else if (rawModels && typeof rawModels === 'object') {
        for (const [alias, raw] of Object.entries(rawModels)) {
            const normalized = normalizeModel(raw, alias);
            if (!normalized) {
                console.warn(`Warning: Invalid llm.models.${alias}, skipping`);
                continue;
            }
            pushModel(parsedModels, normalized);
        }
    }

    if (parsedModels.length > 0) {
        config.llm.models = parsedModels;
    }

    if (process.env.OPENAI_MODEL) {
        config.llm.models = config.llm.models.map((item) =>
            item.provider === 'openai' ? { ...item, model: process.env.OPENAI_MODEL! } : item
        );
    }
    if (process.env.OPENAI_BASE_URL) {
        config.llm.models = config.llm.models.map((item) =>
            item.provider === 'openai' ? { ...item, base_url: process.env.OPENAI_BASE_URL! } : item
        );
    }
    if (process.env.OPENAI_API_KEY) {
        config.llm.models = config.llm.models.map((item) =>
            item.provider === 'openai' ? { ...item, api_key: process.env.OPENAI_API_KEY! } : item
        );
    }
    if (process.env.ANTHROPIC_MODEL) {
        config.llm.models = config.llm.models.map((item) =>
            item.provider === 'anthropic' ? { ...item, model: process.env.ANTHROPIC_MODEL! } : item
        );
    }
    if (process.env.ANTHROPIC_BASE_URL) {
        config.llm.models = config.llm.models.map((item) =>
            item.provider === 'anthropic' ? { ...item, base_url: process.env.ANTHROPIC_BASE_URL! } : item
        );
    }
    if (process.env.ANTHROPIC_API_KEY) {
        config.llm.models = config.llm.models.map((item) =>
            item.provider === 'anthropic' ? { ...item, api_key: process.env.ANTHROPIC_API_KEY! } : item
        );
    }

    if (config.llm.models.length === 0) {
        console.error('Error: No available model configuration found in llm.models');
        process.exit(1);
    }

    let defaultAlias = (config.llm.default_model || '').trim();
    if (!defaultAlias || !config.llm.models.some((item) => item.alias === defaultAlias)) {
        defaultAlias = config.llm.models[0].alias;
    }
    config.llm.default_model = defaultAlias;

    let activeAlias = (process.env.LLM_MODEL_ALIAS || '').trim();
    if (!activeAlias && process.env.LLM_PROVIDER) {
        const preferredProvider = process.env.LLM_PROVIDER.toLowerCase();
        if (preferredProvider === 'openai' || preferredProvider === 'anthropic') {
            const matched = config.llm.models.find((item) => item.provider === preferredProvider);
            if (matched) {
                activeAlias = matched.alias;
            }
        } else {
            console.warn(`Warning: Invalid LLM_PROVIDER=${process.env.LLM_PROVIDER}, ignored`);
        }
    }
    if (!activeAlias) {
        activeAlias = defaultAlias;
    }
    if (!config.llm.models.some((item) => item.alias === activeAlias)) {
        activeAlias = defaultAlias;
    }
    config.llm.active_model_alias = activeAlias;

    const activeModel = config.llm.models.find((item) => item.alias === activeAlias);
    if (!activeModel) {
        console.error(`Error: Active model alias "${activeAlias}" not found`);
        process.exit(1);
    }
    if (!activeModel.api_key) {
        console.error(
            `Error: API key is required for active model "${activeAlias}". ` +
            'Set it in config.json (llm.models[].api_key) or via provider env vars.'
        );
        process.exit(1);
    }

    return config;
}
