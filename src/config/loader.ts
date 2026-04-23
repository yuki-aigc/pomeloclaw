import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    type AgentMemoryEmbeddingProviderConfig,
    type AgentMemoryRetrievalMode,
    type Config,
    type DingTalkConfig,
    type ExecCommandsFile,
    type ExecConfigFile,
    type HooksConfig,
    type IOSConfig,
    type WebConfig,
    type LLMModelConfig,
    type LLMProvider,
    type OpenAIConfig,
    type AnthropicConfig,
    type RawConfigFile,
} from './types.js';
import { DEFAULT_COMMANDS, DEFAULT_CONFIG } from './defaults.js';
import { validateConfig } from './schema.js';
import { readEnvWithCredentialFallback } from '../security/credential-env.js';

/**
 * Load exec commands from a separate file or use inline config
 */
export function loadExecCommands(execConfig: ExecConfigFile): ExecCommandsFile {
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
            } catch {
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

function normalizeIOSConfig(input?: Partial<IOSConfig>): IOSConfig | undefined {
    if (!input) return undefined;

    const defaultIOS = DEFAULT_CONFIG.ios;
    if (!defaultIOS) {
        throw new Error('DEFAULT_CONFIG.ios is not configured');
    }

    const rawPort = Number(input.port);
    const rawMaxPayload = Number(input.maxPayloadBytes);
    const rawPingInterval = Number(input.pingIntervalMs);

    return {
        enabled: input.enabled ?? defaultIOS.enabled,
        host: input.host?.trim() || defaultIOS.host,
        port: Number.isFinite(rawPort) && rawPort > 0
            ? Math.floor(rawPort)
            : defaultIOS.port,
        path: input.path?.trim() || defaultIOS.path,
        authToken: input.authToken?.trim() || undefined,
        debug: input.debug ?? defaultIOS.debug,
        maxPayloadBytes: Number.isFinite(rawMaxPayload) && rawMaxPayload > 0
            ? Math.floor(rawMaxPayload)
            : defaultIOS.maxPayloadBytes,
        pingIntervalMs: Number.isFinite(rawPingInterval) && rawPingInterval >= 0
            ? Math.floor(rawPingInterval)
            : defaultIOS.pingIntervalMs,
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
}

function normalizeWebConfig(input?: Partial<WebConfig>): WebConfig | undefined {
    if (!input) return undefined;

    const defaultWeb = DEFAULT_CONFIG.web;
    if (!defaultWeb) {
        throw new Error('DEFAULT_CONFIG.web is not configured');
    }

    const rawPort = Number(input.port);
    const rawMaxPayload = Number(input.maxPayloadBytes);
    const rawPingInterval = Number(input.pingIntervalMs);

    return {
        enabled: input.enabled ?? defaultWeb.enabled,
        host: input.host?.trim() || defaultWeb.host,
        port: Number.isFinite(rawPort) && rawPort > 0
            ? Math.floor(rawPort)
            : defaultWeb.port,
        path: input.path?.trim() || defaultWeb.path,
        uiPath: input.uiPath?.trim() || defaultWeb.uiPath,
        title: input.title?.trim() || defaultWeb.title,
        authToken: input.authToken?.trim() || undefined,
        debug: input.debug ?? defaultWeb.debug,
        maxPayloadBytes: Number.isFinite(rawMaxPayload) && rawMaxPayload > 0
            ? Math.floor(rawMaxPayload)
            : defaultWeb.maxPayloadBytes,
        pingIntervalMs: Number.isFinite(rawPingInterval) && rawPingInterval >= 0
            ? Math.floor(rawPingInterval)
            : defaultWeb.pingIntervalMs,
    };
}

function normalizeHooksConfig(input?: Partial<HooksConfig>): HooksConfig | undefined {
    if (!input) return undefined;

    const defaultHooks = DEFAULT_CONFIG.hooks;
    if (!defaultHooks) {
        throw new Error('DEFAULT_CONFIG.hooks is not configured');
    }

    const rawPort = Number(input.port);
    const rawMaxPayload = Number(input.maxPayloadBytes);
    const rawMaxConcurrentTasks = Number(input.maxConcurrentTasks);
    const rawTaskTtlMs = Number(input.taskTtlMs);
    const rawShutdownDrainTimeoutMs = Number(input.shutdownDrainTimeoutMs);
    const rawCallbackTimeoutMs = Number(input.callback?.timeoutMs);
    const rawCallbackRetries = Number(input.callback?.retries);
    const rawCallbackRetryDelayMs = Number(input.callback?.retryDelayMs);

    return {
        enabled: input.enabled ?? defaultHooks.enabled,
        host: input.host?.trim() || defaultHooks.host,
        port: Number.isFinite(rawPort) && rawPort > 0
            ? Math.floor(rawPort)
            : defaultHooks.port,
        path: input.path?.trim() || defaultHooks.path,
        authToken: input.authToken?.trim() || undefined,
        debug: input.debug ?? defaultHooks.debug,
        maxPayloadBytes: Number.isFinite(rawMaxPayload) && rawMaxPayload > 0
            ? Math.floor(rawMaxPayload)
            : defaultHooks.maxPayloadBytes,
        maxConcurrentTasks: Number.isFinite(rawMaxConcurrentTasks) && rawMaxConcurrentTasks > 0
            ? Math.floor(rawMaxConcurrentTasks)
            : defaultHooks.maxConcurrentTasks,
        taskTtlMs: Number.isFinite(rawTaskTtlMs) && rawTaskTtlMs > 0
            ? Math.floor(rawTaskTtlMs)
            : defaultHooks.taskTtlMs,
        shutdownDrainTimeoutMs: Number.isFinite(rawShutdownDrainTimeoutMs) && rawShutdownDrainTimeoutMs > 0
            ? Math.floor(rawShutdownDrainTimeoutMs)
            : defaultHooks.shutdownDrainTimeoutMs,
        callback: {
            timeoutMs: Number.isFinite(rawCallbackTimeoutMs) && rawCallbackTimeoutMs > 0
                ? Math.floor(rawCallbackTimeoutMs)
                : defaultHooks.callback?.timeoutMs,
            retries: Number.isFinite(rawCallbackRetries) && rawCallbackRetries >= 0
                ? Math.floor(rawCallbackRetries)
                : defaultHooks.callback?.retries,
            retryDelayMs: Number.isFinite(rawCallbackRetryDelayMs) && rawCallbackRetryDelayMs >= 0
                ? Math.floor(rawCallbackRetryDelayMs)
                : defaultHooks.callback?.retryDelayMs,
        },
    };
}

function normalizeDingTalkConfig(input?: Partial<DingTalkConfig>): DingTalkConfig | undefined {
    if (!input) return undefined;

    const defaultDingTalk = DEFAULT_CONFIG.dingtalk;
    if (!defaultDingTalk) {
        throw new Error('DEFAULT_CONFIG.dingtalk is not configured');
    }

    const rawStreamLockWait = Number(input.streamLockWaitMs);
    const rawStreamLockForceTerminateWait = Number(input.streamLockForceTerminateWaitMs);

    return {
        ...defaultDingTalk,
        ...input,
        clientId: input.clientId?.trim() || defaultDingTalk.clientId,
        clientSecret: input.clientSecret?.trim() || defaultDingTalk.clientSecret,
        robotCode: input.robotCode?.trim() || undefined,
        corpId: input.corpId?.trim() || undefined,
        agentId: input.agentId?.trim() || undefined,
        cardTemplateId: input.cardTemplateId?.trim() || undefined,
        streamLockWaitMs: Number.isFinite(rawStreamLockWait) && rawStreamLockWait > 0
            ? Math.floor(rawStreamLockWait)
            : defaultDingTalk.streamLockWaitMs,
        streamLockForceTerminateOnTimeout: input.streamLockForceTerminateOnTimeout
            ?? defaultDingTalk.streamLockForceTerminateOnTimeout,
        streamLockForceTerminateWaitMs: Number.isFinite(rawStreamLockForceTerminateWait) && rawStreamLockForceTerminateWait > 0
            ? Math.floor(rawStreamLockForceTerminateWait)
            : defaultDingTalk.streamLockForceTerminateWaitMs,
        execApprovals: input.execApprovals
            ? {
                ...input.execApprovals,
                templateId: input.execApprovals.templateId?.trim() || undefined,
            }
            : undefined,
        cron: input.cron
            ? {
                ...input.cron,
                defaultTarget: input.cron.defaultTarget?.trim() || undefined,
                title: input.cron.title?.trim() || undefined,
            }
            : undefined,
    };
}

function normalizeModel(
    raw: Partial<LLMModelConfig> & { alias?: string; provider?: LLMProvider },
    legacyOpenAI: OpenAIConfig,
    legacyAnthropic: AnthropicConfig,
    aliasFallback?: string,
): LLMModelConfig | null {
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
}

function pushModel(list: LLMModelConfig[], model: LLMModelConfig): void {
    const alias = model.alias.trim();
    if (!alias) return;
    const idx = list.findIndex((item) => item.alias === alias);
    if (idx >= 0) {
        list[idx] = { ...model, alias };
    } else {
        list.push({ ...model, alias });
    }
}

function hasText(value: string | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

function applyProviderEnvFallbacks(config: Config): void {
    const openaiModel = readEnvWithCredentialFallback('OPENAI_MODEL');
    const openaiBaseUrl = readEnvWithCredentialFallback('OPENAI_BASE_URL');
    const openaiApiKey = readEnvWithCredentialFallback('OPENAI_API_KEY');
    const anthropicModel = readEnvWithCredentialFallback('ANTHROPIC_MODEL');
    const anthropicBaseUrl = readEnvWithCredentialFallback('ANTHROPIC_BASE_URL');
    const anthropicApiKey = readEnvWithCredentialFallback('ANTHROPIC_API_KEY');

    config.llm.models = config.llm.models.map((item) => {
        if (item.provider === 'openai') {
            return {
                ...item,
                model: hasText(item.model) ? item.model : (openaiModel ?? item.model),
                base_url: hasText(item.base_url) ? item.base_url : (openaiBaseUrl ?? item.base_url),
                api_key: hasText(item.api_key) ? item.api_key : (openaiApiKey ?? item.api_key),
            };
        }

        if (item.provider === 'anthropic') {
            return {
                ...item,
                model: hasText(item.model) ? item.model : (anthropicModel ?? item.model),
                base_url: hasText(item.base_url) ? item.base_url : (anthropicBaseUrl ?? item.base_url),
                api_key: hasText(item.api_key) ? item.api_key : (anthropicApiKey ?? item.api_key),
            };
        }

        return item;
    });
}

function applyMemoryEnvFallbacks(config: Config): void {
    const memoryPgConnectionString = readEnvWithCredentialFallback('MEMORY_PG_CONNECTION_STRING');
    const memoryPgHost = readEnvWithCredentialFallback('MEMORY_PG_HOST');
    const memoryPgPort = readEnvWithCredentialFallback('MEMORY_PG_PORT');
    const memoryPgUser = readEnvWithCredentialFallback('MEMORY_PG_USER');
    const memoryPgPassword = readEnvWithCredentialFallback('MEMORY_PG_PASSWORD');
    const memoryPgDatabase = readEnvWithCredentialFallback('MEMORY_PG_DATABASE');

    if (!hasText(config.agent.memory.pgsql.connection_string) && hasText(memoryPgConnectionString)) {
        config.agent.memory.pgsql.connection_string = memoryPgConnectionString;
        config.agent.memory.pgsql.enabled = true;
    }

    if (!hasText(config.agent.memory.pgsql.host) && hasText(memoryPgHost)) {
        config.agent.memory.pgsql.host = memoryPgHost;
    }

    if (hasText(memoryPgPort)) {
        const port = Number(memoryPgPort);
        if (Number.isFinite(port) && port > 0) {
            const shouldApplyPort = config.agent.memory.pgsql.port === DEFAULT_CONFIG.agent.memory.pgsql.port;
            if (shouldApplyPort) {
                config.agent.memory.pgsql.port = Math.floor(port);
            }
        }
    }

    if (!hasText(config.agent.memory.pgsql.user) && hasText(memoryPgUser)) {
        config.agent.memory.pgsql.user = memoryPgUser;
    }

    if (!hasText(config.agent.memory.pgsql.password) && hasText(memoryPgPassword)) {
        config.agent.memory.pgsql.password = memoryPgPassword;
    }

    if (!hasText(config.agent.memory.pgsql.database) && hasText(memoryPgDatabase)) {
        config.agent.memory.pgsql.database = memoryPgDatabase;
    }
}

function normalizeMemoryConfig(config: Config): void {
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
    config.agent.memory.retrieval.max_injected_chars = Math.max(
        500,
        Math.floor(config.agent.memory.retrieval.max_injected_chars)
    );
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
}

function resolveActiveAlias(config: Config): void {
    let defaultAlias = (config.llm.default_model || '').trim();
    if (!defaultAlias || !config.llm.models.some((item) => item.alias === defaultAlias)) {
        defaultAlias = config.llm.models[0].alias;
    }
    config.llm.default_model = defaultAlias;

    let activeAlias = (config.llm.active_model_alias || '').trim();
    if (!activeAlias) {
        activeAlias = (readEnvWithCredentialFallback('LLM_MODEL_ALIAS') || '').trim();
    }
    const envProvider = readEnvWithCredentialFallback('LLM_PROVIDER');
    if (!activeAlias && envProvider) {
        const preferredProvider = envProvider.toLowerCase();
        if (preferredProvider === 'openai' || preferredProvider === 'anthropic') {
            const matched = config.llm.models.find((item) => item.provider === preferredProvider);
            if (matched) {
                activeAlias = matched.alias;
            }
        } else {
            console.warn(`Warning: Invalid LLM_PROVIDER=${envProvider}, ignored`);
        }
    }
    if (!activeAlias) {
        activeAlias = defaultAlias;
    }
    if (!config.llm.models.some((item) => item.alias === activeAlias)) {
        activeAlias = defaultAlias;
    }
    config.llm.active_model_alias = activeAlias;
}

export function loadConfig(): Config {
    const configPath = join(process.cwd(), 'config.json');

    let fileConfig: RawConfigFile = {};
    if (existsSync(configPath)) {
        try {
            const content = readFileSync(configPath, 'utf-8');
            fileConfig = JSON.parse(content) as RawConfigFile;
        } catch {
            console.warn('Warning: Failed to parse config.json, using defaults');
        }
    }

    const fallbackExecConfig: ExecConfigFile = {
        enabled: DEFAULT_CONFIG.exec.enabled,
        defaultTimeoutMs: DEFAULT_CONFIG.exec.defaultTimeoutMs,
        maxOutputLength: DEFAULT_CONFIG.exec.maxOutputLength,
        approvals: {
            enabled: DEFAULT_CONFIG.exec.approvals.enabled,
        },
    };
    const execCommands = loadExecCommands(fileConfig.exec || fallbackExecConfig);

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

    const defaultEmbeddingProvider = DEFAULT_CONFIG.agent.memory.embedding.providers[0];
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
                        base_url: baseUrl || defaultEmbeddingProvider.base_url,
                        model: model || defaultEmbeddingProvider.model,
                        api_key: apiKey || '',
                        timeout_ms: item.timeout_ms && item.timeout_ms > 0
                            ? Math.floor(item.timeout_ms)
                            : defaultEmbeddingProvider.timeout_ms,
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
            workspace: fileConfig.agent?.workspace ?? DEFAULT_CONFIG.agent.workspace,
            skills_dir: fileConfig.agent?.skills_dir ?? DEFAULT_CONFIG.agent.skills_dir,
            recursion_limit: fileConfig.agent?.recursion_limit ?? DEFAULT_CONFIG.agent.recursion_limit,
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
            allowShellOperators: fileConfig.exec?.allowShellOperators ?? DEFAULT_CONFIG.exec.allowShellOperators,
            shellAllowedCommands: fileConfig.exec?.shellAllowedCommands ?? DEFAULT_CONFIG.exec.shellAllowedCommands,
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
        dingtalk: normalizeDingTalkConfig(fileConfig.dingtalk),
        ios: normalizeIOSConfig(fileConfig.ios),
        web: normalizeWebConfig(fileConfig.web),
        hooks: normalizeHooksConfig(fileConfig.hooks),
    };

    const parsedModels: LLMModelConfig[] = [];
    const rawModels = fileConfig.llm?.models;
    if (Array.isArray(rawModels)) {
        for (const raw of rawModels) {
            const normalized = normalizeModel(raw, legacyOpenAI, legacyAnthropic);
            if (!normalized) {
                console.warn('Warning: Invalid llm.models item, skipping');
                continue;
            }
            pushModel(parsedModels, normalized);
        }
    } else if (rawModels && typeof rawModels === 'object') {
        for (const [alias, raw] of Object.entries(rawModels)) {
            const normalized = normalizeModel(raw, legacyOpenAI, legacyAnthropic, alias);
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

    applyProviderEnvFallbacks(config);
    applyMemoryEnvFallbacks(config);

    if (config.llm.models.length === 0) {
        console.error('Error: No available model configuration found in llm.models');
        process.exit(1);
    }

    resolveActiveAlias(config);

    const activeModel = config.llm.models.find((item) => item.alias === config.llm.active_model_alias);
    if (!activeModel) {
        console.error(`Error: Active model alias "${config.llm.active_model_alias}" not found`);
        process.exit(1);
    }
    if (!activeModel.api_key) {
        console.error(
            `Error: API key is required for active model "${config.llm.active_model_alias}". ` +
            'Set it in config.json (llm.models[].api_key) or via provider env vars.'
        );
        process.exit(1);
    }

    normalizeMemoryConfig(config);

    return validateConfig(config);
}
