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

export type AgentMemoryBackend = 'filesystem' | 'pgsql';
export type AgentMemoryRetrievalMode = 'keyword' | 'fts' | 'vector' | 'hybrid';

export interface AgentMemoryPgsqlConfig {
    enabled: boolean;
    connection_string?: string;
    host?: string;
    port: number;
    user?: string;
    password?: string;
    database?: string;
    ssl: boolean;
    schema: string;
}

export interface AgentMemoryRetrievalConfig {
    mode: AgentMemoryRetrievalMode;
    max_results: number;
    min_score: number;
    sync_on_search: boolean;
    sync_min_interval_ms: number;
    hybrid_vector_weight: number;
    hybrid_fts_weight: number;
    hybrid_candidate_multiplier: number;
    include_session_events: boolean;
    session_events_max_results: number;
    session_events_vector_async_enabled: boolean;
    session_events_vector_async_interval_ms: number;
    session_events_vector_async_batch_size: number;
    session_events_ttl_days: number;
    session_events_ttl_cleanup_interval_ms: number;
}

export interface AgentMemoryEmbeddingProviderConfig {
    provider: 'openai';
    base_url: string;
    model: string;
    api_key: string;
    timeout_ms: number;
}

export interface AgentMemoryEmbeddingConfig {
    enabled: boolean;
    cache_enabled: boolean;
    providers: AgentMemoryEmbeddingProviderConfig[];
}

export interface AgentMemorySessionIsolationConfig {
    enabled: boolean;
    direct_scope: 'main' | 'direct';
    group_scope_prefix: string;
}

export interface AgentMemoryTranscriptConfig {
    enabled: boolean;
    max_chars_per_entry: number;
}

export interface AgentMemoryConfig {
    backend: AgentMemoryBackend;
    pgsql: AgentMemoryPgsqlConfig;
    retrieval: AgentMemoryRetrievalConfig;
    embedding: AgentMemoryEmbeddingConfig;
    session_isolation: AgentMemorySessionIsolationConfig;
    transcript: AgentMemoryTranscriptConfig;
}

export interface AgentConfig {
    workspace: string;
    skills_dir: string;
    recursion_limit: number;
    compaction: CompactionConfig;
    memory: AgentMemoryConfig;
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
    env?: Record<string, string>;
    defaultToolTimeout?: number;
    outputHandling?: MCPOutputHandling;
}

export interface MCPServerStdioConfig extends MCPServerBaseConfig {
    transport: 'stdio';
    command: string;
    args?: string[];
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
        autoMemorySaveAt4?: boolean;
    };
}

export interface IOSConfig {
    enabled: boolean;
    host: string;
    port: number;
    path: string;
    authToken?: string;
    debug?: boolean;
    maxPayloadBytes?: number;
    pingIntervalMs?: number;
    cron?: {
        defaultTarget?: string;
        useMarkdown?: boolean;
        title?: string;
        store?: string;
        runLog?: string;
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
    ios?: IOSConfig;
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
        memory: {
            backend: 'filesystem' as const,
            pgsql: {
                enabled: false,
                connection_string: '',
                host: '127.0.0.1',
                port: 5432,
                user: 'pomelobot',
                password: '',
                database: 'pomelobot',
                ssl: false,
                schema: 'pomelobot_memory',
            },
            retrieval: {
                mode: 'keyword' as const,
                max_results: 8,
                min_score: 0.1,
                sync_on_search: true,
                sync_min_interval_ms: 20000,
                hybrid_vector_weight: 0.6,
                hybrid_fts_weight: 0.4,
                hybrid_candidate_multiplier: 2,
                include_session_events: true,
                session_events_max_results: 6,
                session_events_vector_async_enabled: true,
                session_events_vector_async_interval_ms: 5000,
                session_events_vector_async_batch_size: 16,
                session_events_ttl_days: 30,
                session_events_ttl_cleanup_interval_ms: 10 * 60 * 1000,
            },
            embedding: {
                enabled: false,
                cache_enabled: true,
                providers: [
                    {
                        provider: 'openai' as const,
                        base_url: 'https://api.openai.com/v1',
                        model: 'text-embedding-3-small',
                        api_key: '',
                        timeout_ms: 15000,
                    },
                ],
            },
            session_isolation: {
                enabled: true,
                direct_scope: 'main' as const,
                group_scope_prefix: 'group_',
            },
            transcript: {
                enabled: false,
                max_chars_per_entry: 3000,
            },
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
    ios: {
        enabled: false,
        host: '0.0.0.0',
        port: 18080,
        path: '/ws/ios',
        debug: false,
        maxPayloadBytes: 1024 * 1024,
        pingIntervalMs: 30000,
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

    const normalizeIOSConfig = (input?: Partial<IOSConfig>): IOSConfig | undefined => {
        if (!input) return undefined;

        const rawPort = Number(input.port);
        const rawMaxPayload = Number(input.maxPayloadBytes);
        const rawPingInterval = Number(input.pingIntervalMs);

        return {
            enabled: input.enabled ?? DEFAULT_CONFIG.ios.enabled,
            host: input.host?.trim() || DEFAULT_CONFIG.ios.host,
            port: Number.isFinite(rawPort) && rawPort > 0
                ? Math.floor(rawPort)
                : DEFAULT_CONFIG.ios.port,
            path: input.path?.trim() || DEFAULT_CONFIG.ios.path,
            authToken: input.authToken?.trim() || undefined,
            debug: input.debug ?? DEFAULT_CONFIG.ios.debug,
            maxPayloadBytes: Number.isFinite(rawMaxPayload) && rawMaxPayload > 0
                ? Math.floor(rawMaxPayload)
                : DEFAULT_CONFIG.ios.maxPayloadBytes,
            pingIntervalMs: Number.isFinite(rawPingInterval) && rawPingInterval >= 0
                ? Math.floor(rawPingInterval)
                : DEFAULT_CONFIG.ios.pingIntervalMs,
            cron: input.cron
                ? {
                    defaultTarget: input.cron.defaultTarget?.trim() || undefined,
                    useMarkdown: input.cron.useMarkdown,
                    title: input.cron.title?.trim() || undefined,
                    store: input.cron.store?.trim() || undefined,
                    runLog: input.cron.runLog?.trim() || undefined,
                }
                : undefined,
        };
    };

    let fileConfig: {
        llm?: {
            default_model?: string;
            active_model_alias?: string;
            models?: Array<Partial<LLMModelConfig> & { alias?: string; provider?: LLMProvider }>
            | Record<string, Partial<LLMModelConfig> & { provider?: LLMProvider }>;
        };
        openai?: Partial<OpenAIConfig>;
        anthropic?: Partial<AnthropicConfig>;
        agent?: Partial<AgentConfig> & {
            compaction?: Partial<CompactionConfig>;
            memory?: Partial<AgentMemoryConfig> & {
                pgsql?: Partial<AgentMemoryPgsqlConfig>;
                retrieval?: Partial<AgentMemoryRetrievalConfig>;
                embedding?: Partial<AgentMemoryEmbeddingConfig> & {
                    providers?: Array<Partial<AgentMemoryEmbeddingProviderConfig>>;
                };
                session_isolation?: Partial<AgentMemorySessionIsolationConfig>;
                transcript?: Partial<AgentMemoryTranscriptConfig>;
            };
        };
        exec?: ExecConfigFile;
        mcp?: Partial<MCPConfig>;
        cron?: Partial<CronConfig>;
        dingtalk?: DingTalkConfig;
        ios?: Partial<IOSConfig>;
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

    const configuredEmbeddingProviders = fileConfig.agent?.memory?.embedding?.providers;
    const normalizedEmbeddingProviders: AgentMemoryEmbeddingProviderConfig[] =
        Array.isArray(configuredEmbeddingProviders) && configuredEmbeddingProviders.length > 0
            ? configuredEmbeddingProviders
                .map((item) => {
                    if (item.provider !== 'openai') return null;
                    const baseUrl = item.base_url?.trim();
                    const model = item.model?.trim();
                    const apiKey = item.api_key?.trim();
                    return {
                        provider: 'openai' as const,
                        base_url: baseUrl || DEFAULT_CONFIG.agent.memory.embedding.providers[0].base_url,
                        model: model || DEFAULT_CONFIG.agent.memory.embedding.providers[0].model,
                        api_key: apiKey || '',
                        timeout_ms: item.timeout_ms && item.timeout_ms > 0
                            ? Math.floor(item.timeout_ms)
                            : DEFAULT_CONFIG.agent.memory.embedding.providers[0].timeout_ms,
                    };
                })
                .filter((item): item is AgentMemoryEmbeddingProviderConfig => Boolean(item))
            : [...DEFAULT_CONFIG.agent.memory.embedding.providers];

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
            memory: {
                ...DEFAULT_CONFIG.agent.memory,
                ...(fileConfig.agent?.memory || {}),
                pgsql: {
                    ...DEFAULT_CONFIG.agent.memory.pgsql,
                    ...(fileConfig.agent?.memory?.pgsql || {}),
                },
                retrieval: {
                    ...DEFAULT_CONFIG.agent.memory.retrieval,
                    ...(fileConfig.agent?.memory?.retrieval || {}),
                },
                embedding: {
                    ...DEFAULT_CONFIG.agent.memory.embedding,
                    ...(fileConfig.agent?.memory?.embedding || {}),
                    providers: normalizedEmbeddingProviders,
                },
                session_isolation: {
                    ...DEFAULT_CONFIG.agent.memory.session_isolation,
                    ...(fileConfig.agent?.memory?.session_isolation || {}),
                },
                transcript: {
                    ...DEFAULT_CONFIG.agent.memory.transcript,
                    ...(fileConfig.agent?.memory?.transcript || {}),
                },
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
        ios: normalizeIOSConfig(fileConfig.ios),
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

    if (process.env.MEMORY_BACKEND) {
        const backend = process.env.MEMORY_BACKEND.trim().toLowerCase();
        if (backend === 'filesystem' || backend === 'pgsql') {
            config.agent.memory.backend = backend;
        }
    }
    if (process.env.MEMORY_PG_CONNECTION_STRING) {
        config.agent.memory.pgsql.connection_string = process.env.MEMORY_PG_CONNECTION_STRING;
        config.agent.memory.pgsql.enabled = true;
    }
    if (process.env.MEMORY_PG_HOST) {
        config.agent.memory.pgsql.host = process.env.MEMORY_PG_HOST;
    }
    if (process.env.MEMORY_PG_PORT) {
        const port = Number(process.env.MEMORY_PG_PORT);
        if (Number.isFinite(port) && port > 0) {
            config.agent.memory.pgsql.port = Math.floor(port);
        }
    }
    if (process.env.MEMORY_PG_USER) {
        config.agent.memory.pgsql.user = process.env.MEMORY_PG_USER;
    }
    if (process.env.MEMORY_PG_PASSWORD) {
        config.agent.memory.pgsql.password = process.env.MEMORY_PG_PASSWORD;
    }
    if (process.env.MEMORY_PG_DATABASE) {
        config.agent.memory.pgsql.database = process.env.MEMORY_PG_DATABASE;
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

    if (config.agent.memory.backend === 'pgsql') {
        config.agent.memory.pgsql.enabled = true;
    }

    const retrievalMode = config.agent.memory.retrieval.mode;
    const validRetrievalMode: AgentMemoryRetrievalMode[] = ['keyword', 'fts', 'vector', 'hybrid'];
    if (!validRetrievalMode.includes(retrievalMode)) {
        config.agent.memory.retrieval.mode = DEFAULT_CONFIG.agent.memory.retrieval.mode;
    }
    config.agent.memory.retrieval.max_results = Math.max(1, Math.floor(config.agent.memory.retrieval.max_results));
    config.agent.memory.retrieval.min_score = Math.max(0, Math.min(1, config.agent.memory.retrieval.min_score));
    config.agent.memory.retrieval.sync_min_interval_ms = Math.max(1000, Math.floor(config.agent.memory.retrieval.sync_min_interval_ms));
    config.agent.memory.retrieval.hybrid_vector_weight = Math.max(0, Math.min(1, config.agent.memory.retrieval.hybrid_vector_weight));
    config.agent.memory.retrieval.hybrid_fts_weight = Math.max(0, Math.min(1, config.agent.memory.retrieval.hybrid_fts_weight));
    const hybridWeightSum = config.agent.memory.retrieval.hybrid_vector_weight + config.agent.memory.retrieval.hybrid_fts_weight;
    if (hybridWeightSum <= 0) {
        config.agent.memory.retrieval.hybrid_vector_weight = DEFAULT_CONFIG.agent.memory.retrieval.hybrid_vector_weight;
        config.agent.memory.retrieval.hybrid_fts_weight = DEFAULT_CONFIG.agent.memory.retrieval.hybrid_fts_weight;
    } else {
        config.agent.memory.retrieval.hybrid_vector_weight /= hybridWeightSum;
        config.agent.memory.retrieval.hybrid_fts_weight /= hybridWeightSum;
    }
    config.agent.memory.retrieval.hybrid_candidate_multiplier = Math.max(
        1,
        Math.floor(config.agent.memory.retrieval.hybrid_candidate_multiplier)
    );
    config.agent.memory.retrieval.include_session_events = config.agent.memory.retrieval.include_session_events !== false;
    config.agent.memory.retrieval.session_events_max_results = Math.max(
        1,
        Math.floor(config.agent.memory.retrieval.session_events_max_results)
    );
    config.agent.memory.retrieval.session_events_vector_async_enabled =
        config.agent.memory.retrieval.session_events_vector_async_enabled !== false;
    config.agent.memory.retrieval.session_events_vector_async_interval_ms = Math.max(
        1000,
        Math.floor(config.agent.memory.retrieval.session_events_vector_async_interval_ms)
    );
    config.agent.memory.retrieval.session_events_vector_async_batch_size = Math.max(
        1,
        Math.floor(config.agent.memory.retrieval.session_events_vector_async_batch_size)
    );
    config.agent.memory.retrieval.session_events_ttl_days = Math.max(
        0,
        Math.floor(config.agent.memory.retrieval.session_events_ttl_days)
    );
    config.agent.memory.retrieval.session_events_ttl_cleanup_interval_ms = Math.max(
        60_000,
        Math.floor(config.agent.memory.retrieval.session_events_ttl_cleanup_interval_ms)
    );
    config.agent.memory.transcript.max_chars_per_entry = Math.max(
        200,
        Math.floor(config.agent.memory.transcript.max_chars_per_entry)
    );

    return config;
}
