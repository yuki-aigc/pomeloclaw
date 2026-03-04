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
    max_injected_chars: number;
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
    web_direct_scope: 'main' | 'direct';
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

export interface WebConfig {
    enabled: boolean;
    host: string;
    port: number;
    path: string;
    uiPath: string;
    title: string;
    authToken?: string;
    debug?: boolean;
    maxPayloadBytes?: number;
    pingIntervalMs?: number;
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
    web?: WebConfig;
}

export interface RawConfigFile {
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
    dingtalk?: Partial<DingTalkConfig>;
    ios?: Partial<IOSConfig>;
    web?: Partial<WebConfig>;
}
