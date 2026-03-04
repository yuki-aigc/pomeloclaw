import type { Config, ExecCommandsFile, LLMModelConfig } from './types.js';

export const DEFAULT_COMMANDS: ExecCommandsFile = {
    allowedCommands: [
        'ls', 'cat', 'head', 'tail', 'grep', 'find', 'pwd', 'echo',
        'date', 'whoami', 'df', 'uptime', 'ps',
    ],
    deniedCommands: ['rm', 'mv', 'cp', 'chmod', 'chown', 'sudo', 'su'],
};

export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const DEFAULT_CONFIG: Config = {
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
                max_injected_chars: 6000,
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
                direct_scope: 'direct' as const,
                web_direct_scope: 'main' as const,
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
        allowedCommands: [...DEFAULT_COMMANDS.allowedCommands],
        deniedCommands: [...DEFAULT_COMMANDS.deniedCommands],
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
    web: {
        enabled: false,
        host: '0.0.0.0',
        port: 18081,
        path: '/ws/web',
        uiPath: '/web',
        title: 'Pomelobot Web',
        debug: false,
        maxPayloadBytes: 1024 * 1024,
        pingIntervalMs: 30000,
    },
};
