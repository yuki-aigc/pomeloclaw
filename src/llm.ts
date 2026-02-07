import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Config, LLMModelConfig, LLMProvider } from './config.js';

export interface ModelSummary {
    alias: string;
    provider: LLMProvider;
    model: string;
    isActive: boolean;
}

export function getActiveModelAlias(config: Config): string {
    return config.llm.active_model_alias;
}

export function getActiveModelEntry(config: Config): LLMModelConfig {
    const alias = getActiveModelAlias(config);
    const entry = config.llm.models.find((item) => item.alias === alias);
    if (!entry) {
        throw new Error(`Active model alias "${alias}" is not configured`);
    }
    return entry;
}

export function hasModelAlias(config: Config, alias: string): boolean {
    return config.llm.models.some((item) => item.alias === alias);
}

export function setActiveModelAlias(config: Config, alias: string): void {
    const entry = config.llm.models.find((item) => item.alias === alias);
    if (!entry) {
        throw new Error(`Model alias "${alias}" not found`);
    }

    config.llm.active_model_alias = alias;
}

export function listConfiguredModels(config: Config): ModelSummary[] {
    const activeAlias = getActiveModelAlias(config);
    return [...config.llm.models]
        .sort((a, b) => a.alias.localeCompare(b.alias))
        .map((entry) => ({
            alias: entry.alias,
            provider: entry.provider,
            model: entry.model,
            isActive: entry.alias === activeAlias,
        }));
}

export function getActiveModelName(config: Config): string {
    return getActiveModelEntry(config).model;
}

export function getModelCacheKey(config: Config): string {
    const alias = getActiveModelAlias(config);
    const entry = getActiveModelEntry(config);
    const headersPart = Object.entries(entry.headers || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}:${value}`)
        .join(',');
    return [
        alias,
        entry.provider,
        entry.base_url,
        entry.model,
        entry.api_key,
        headersPart,
        String(entry.max_retries ?? 3),
    ].join('|');
}

function buildDefaultHeaders(entry: LLMModelConfig): Record<string, string> | undefined {
    const headers = entry.headers || {};
    return Object.keys(headers).length > 0 ? headers : undefined;
}

async function loadChatAnthropicCtor(): Promise<new (options: Record<string, unknown>) => BaseChatModel> {
    const moduleName = '@langchain/anthropic' as string;
    try {
        const mod = (await import(moduleName)) as { ChatAnthropic?: new (options: Record<string, unknown>) => BaseChatModel };
        if (!mod.ChatAnthropic) {
            throw new Error('ChatAnthropic export not found');
        }
        return mod.ChatAnthropic;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Anthropic provider selected but @langchain/anthropic is unavailable. ` +
            `Please install it with "pnpm add @langchain/anthropic". (${message})`
        );
    }
}

export async function createChatModel(
    config: Config,
    options: { temperature?: number } = {},
): Promise<BaseChatModel> {
    const entry = getActiveModelEntry(config);
    const temperature = options.temperature ?? 0;
    const defaultHeaders = buildDefaultHeaders(entry);

    if (entry.provider === 'openai') {
        return new ChatOpenAI({
            model: entry.model,
            apiKey: entry.api_key,
            configuration: {
                baseURL: entry.base_url,
                ...(defaultHeaders ? { defaultHeaders } : {}),
            },
            maxRetries: entry.max_retries ?? 3,
            temperature,
        });
    }

    const ChatAnthropic = await loadChatAnthropicCtor();
    const clientOptions: Record<string, unknown> = {};
    if (entry.base_url) {
        clientOptions.baseURL = entry.base_url;
    }
    if (defaultHeaders) {
        clientOptions.defaultHeaders = defaultHeaders;
    }

    const anthropicOptions: Record<string, unknown> = {
        model: entry.model,
        maxRetries: entry.max_retries ?? 3,
        temperature,
    };

    anthropicOptions.apiKey = entry.api_key;
    anthropicOptions.anthropicApiKey = entry.api_key;

    if (Object.keys(clientOptions).length > 0) {
        anthropicOptions.clientOptions = clientOptions;
    }

    return new ChatAnthropic(anthropicOptions);
}
