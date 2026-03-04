import { z } from 'zod';
import type { Config } from './types.js';

const mcpOutputHandlingSchema = z.union([
    z.enum(['content', 'artifact']),
    z.object({
        text: z.enum(['content', 'artifact']).optional(),
        image: z.enum(['content', 'artifact']).optional(),
        audio: z.enum(['content', 'artifact']).optional(),
        resource: z.enum(['content', 'artifact']).optional(),
        resource_link: z.enum(['content', 'artifact']).optional(),
    }).partial(),
]);

const mcpServerBaseSchema = z.object({
    env: z.record(z.string(), z.string()).optional(),
    defaultToolTimeout: z.number().int().nonnegative().optional(),
    outputHandling: mcpOutputHandlingSchema.optional(),
});

const mcpServerStdioSchema = mcpServerBaseSchema.extend({
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    stderr: z.enum(['overlapped', 'pipe', 'ignore', 'inherit']).optional(),
    restart: z.object({
        enabled: z.boolean().optional(),
        maxAttempts: z.number().int().nonnegative().optional(),
        delayMs: z.number().int().nonnegative().optional(),
    }).optional(),
});

const mcpServerHttpSchema = mcpServerBaseSchema.extend({
    transport: z.enum(['http', 'sse']),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    reconnect: z.object({
        enabled: z.boolean().optional(),
        maxAttempts: z.number().int().nonnegative().optional(),
        delayMs: z.number().int().nonnegative().optional(),
    }).optional(),
    automaticSSEFallback: z.boolean().optional(),
});

const mcpServerSchema = z.union([mcpServerStdioSchema, mcpServerHttpSchema]);

const llmModelSchema = z.object({
    alias: z.string().min(1),
    provider: z.enum(['openai', 'anthropic']),
    base_url: z.string().min(1),
    model: z.string().min(1),
    api_key: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    max_retries: z.number().int().nonnegative().optional(),
});

const configSchemaInternal = z.object({
    llm: z.object({
        default_model: z.string().min(1),
        active_model_alias: z.string().min(1),
        models: z.array(llmModelSchema).min(1),
    }),
    agent: z.object({
        workspace: z.string().min(1),
        skills_dir: z.string().min(1),
        recursion_limit: z.number().int().positive(),
        compaction: z.object({
            enabled: z.boolean(),
            auto_compact_threshold: z.number().int().nonnegative(),
            context_window: z.number().int().positive(),
            reserve_tokens: z.number().int().nonnegative(),
            max_history_share: z.number().min(0).max(1),
        }),
        memory: z.object({
            backend: z.enum(['filesystem', 'pgsql']),
            pgsql: z.object({
                enabled: z.boolean(),
                connection_string: z.string().optional(),
                host: z.string().optional(),
                port: z.number().int().positive(),
                user: z.string().optional(),
                password: z.string().optional(),
                database: z.string().optional(),
                ssl: z.boolean(),
                schema: z.string().min(1),
            }),
            retrieval: z.object({
                mode: z.enum(['keyword', 'fts', 'vector', 'hybrid']),
                max_results: z.number().int().positive(),
                min_score: z.number().min(0).max(1),
                max_injected_chars: z.number().int().positive(),
                sync_on_search: z.boolean(),
                sync_min_interval_ms: z.number().int().positive(),
                hybrid_vector_weight: z.number().min(0).max(1),
                hybrid_fts_weight: z.number().min(0).max(1),
                hybrid_candidate_multiplier: z.number().int().positive(),
                include_session_events: z.boolean(),
                session_events_max_results: z.number().int().positive(),
                session_events_vector_async_enabled: z.boolean(),
                session_events_vector_async_interval_ms: z.number().int().positive(),
                session_events_vector_async_batch_size: z.number().int().positive(),
                session_events_ttl_days: z.number().int().nonnegative(),
                session_events_ttl_cleanup_interval_ms: z.number().int().positive(),
            }),
            embedding: z.object({
                enabled: z.boolean(),
                cache_enabled: z.boolean(),
                providers: z.array(z.object({
                    provider: z.literal('openai'),
                    base_url: z.string().min(1),
                    model: z.string().min(1),
                    api_key: z.string(),
                    timeout_ms: z.number().int().positive(),
                })).min(1),
            }),
            session_isolation: z.object({
                enabled: z.boolean(),
                direct_scope: z.enum(['main', 'direct']),
                web_direct_scope: z.enum(['main', 'direct']),
                group_scope_prefix: z.string(),
            }),
            transcript: z.object({
                enabled: z.boolean(),
                max_chars_per_entry: z.number().int().positive(),
            }),
        }),
    }),
    exec: z.object({
        enabled: z.boolean(),
        allowedCommands: z.array(z.string()),
        deniedCommands: z.array(z.string()),
        defaultTimeoutMs: z.number().int().positive(),
        maxOutputLength: z.number().int().positive(),
        approvals: z.object({
            enabled: z.boolean(),
        }),
    }),
    mcp: z.object({
        enabled: z.boolean(),
        throwOnLoadError: z.boolean().optional(),
        prefixToolNameWithServerName: z.boolean().optional(),
        additionalToolNamePrefix: z.string().optional(),
        useStandardContentBlocks: z.boolean().optional(),
        onConnectionError: z.enum(['throw', 'ignore']).optional(),
        servers: z.record(z.string(), mcpServerSchema),
    }),
    cron: z.object({
        enabled: z.boolean(),
        store: z.string().min(1),
        timezone: z.string().optional(),
        runLog: z.string().optional(),
    }),
    dingtalk: z.object({
        enabled: z.boolean(),
        clientId: z.string(),
        clientSecret: z.string(),
        robotCode: z.string().optional(),
        corpId: z.string().optional(),
        agentId: z.string().optional(),
        messageType: z.enum(['markdown', 'card']).optional(),
        cardTemplateId: z.string().optional(),
        showThinking: z.boolean().optional(),
        debug: z.boolean().optional(),
        execApprovals: z.object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().positive().optional(),
            mode: z.enum(['text', 'button']).optional(),
            templateId: z.string().optional(),
        }).optional(),
        voice: z.object({
            enabled: z.boolean().optional(),
            requireRecognition: z.boolean().optional(),
            prependRecognitionHint: z.boolean().optional(),
        }).optional(),
        cron: z.object({
            defaultTarget: z.string().optional(),
            useMarkdown: z.boolean().optional(),
            title: z.string().optional(),
            autoMemorySaveAt4: z.boolean().optional(),
        }).optional(),
    }).optional(),
    ios: z.object({
        enabled: z.boolean(),
        host: z.string().min(1),
        port: z.number().int().positive(),
        path: z.string().min(1),
        authToken: z.string().optional(),
        debug: z.boolean().optional(),
        maxPayloadBytes: z.number().int().positive().optional(),
        pingIntervalMs: z.number().int().nonnegative().optional(),
        cron: z.object({
            defaultTarget: z.string().optional(),
            useMarkdown: z.boolean().optional(),
            title: z.string().optional(),
            store: z.string().optional(),
            runLog: z.string().optional(),
        }).optional(),
    }).optional(),
    web: z.object({
        enabled: z.boolean(),
        host: z.string().min(1),
        port: z.number().int().positive(),
        path: z.string().min(1),
        uiPath: z.string().min(1),
        title: z.string().min(1),
        authToken: z.string().optional(),
        debug: z.boolean().optional(),
        maxPayloadBytes: z.number().int().positive().optional(),
        pingIntervalMs: z.number().int().nonnegative().optional(),
    }).optional(),
});

export const configSchema = configSchemaInternal;

export function validateConfig(config: Config): Config {
    const parsed = configSchema.safeParse(config);
    if (parsed.success) {
        return parsed.data;
    }

    const issueText = parsed.error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
            return `- ${path}: ${issue.message}`;
        })
        .join('\n');

    throw new Error(`[Config] 配置校验失败:\n${issueText}`);
}
