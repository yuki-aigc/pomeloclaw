import { createAgent } from '../agent.js';
import type {
    AgentContext,
    AgentRuntimeChannel,
    CreateAgentOptions,
    ExecApprovalPrompt,
    RuntimeAgent,
} from '../agent.js';
import { MemorySaver } from '@langchain/langgraph';
import type { Config } from '../config.js';
import {
    getActiveModelAlias,
    getActiveModelName,
    hasModelAlias,
    setActiveModelAlias,
} from '../llm.js';
import { buildPromptBootstrapMessage } from '../prompt/bootstrap.js';

export interface ConversationRuntimeOptions {
    config: Config;
    runtimeChannel: AgentRuntimeChannel;
    execApprovalPrompt?: ExecApprovalPrompt;
}

export interface SwitchModelResult {
    alias: string;
    model: string;
}

export interface BuildBootstrapMessagesOptions {
    threadId: string;
    workspacePath: string;
    scopeKey: string;
}

export class ConversationRuntime {
    private readonly config: Config;
    private readonly runtimeChannel: AgentRuntimeChannel;
    private readonly execApprovalPrompt?: ExecApprovalPrompt;
    private readonly checkpointer = new MemorySaver();
    private agentContext: AgentContext | null = null;
    private readonly bootstrappedThreads = new Set<string>();
    private reloadRequested = false;

    constructor(options: ConversationRuntimeOptions) {
        this.config = options.config;
        this.runtimeChannel = options.runtimeChannel;
        this.execApprovalPrompt = options.execApprovalPrompt;
    }

    async initialize(): Promise<void> {
        if (this.agentContext) {
            return;
        }
        this.agentContext = await this.createAgentContext();
    }

    getAgent(): RuntimeAgent {
        const ctx = this.agentContext;
        if (!ctx) {
            throw new Error('ConversationRuntime has not been initialized');
        }
        return ctx.agent;
    }

    async close(): Promise<void> {
        if (!this.agentContext) {
            return;
        }

        const current = this.agentContext;
        this.agentContext = null;
        await current.cleanup();
    }

    requestReload(): void {
        this.reloadRequested = true;
    }

    async reloadIfNeeded(): Promise<boolean> {
        if (!this.reloadRequested) {
            return false;
        }
        await this.reloadAgent();
        return true;
    }

    async reloadAgent(): Promise<void> {
        const previousContext = this.agentContext;
        const nextContext = await this.createAgentContext();
        this.agentContext = nextContext;
        this.reloadRequested = false;

        if (previousContext) {
            await previousContext.cleanup();
        }
    }

    async switchModel(alias: string): Promise<SwitchModelResult> {
        const trimmedAlias = alias.trim();
        if (!trimmedAlias) {
            throw new Error('模型别名不能为空');
        }
        if (!hasModelAlias(this.config, trimmedAlias)) {
            throw new Error(`未找到模型别名: ${trimmedAlias}`);
        }

        const previousAlias = getActiveModelAlias(this.config);
        if (previousAlias === trimmedAlias) {
            return {
                alias: trimmedAlias,
                model: getActiveModelName(this.config),
            };
        }

        const previousContext = this.agentContext;
        let nextContext: AgentContext | null = null;

        try {
            setActiveModelAlias(this.config, trimmedAlias);
            nextContext = await this.createAgentContext();
            this.agentContext = nextContext;
            this.reloadRequested = false;

            if (previousContext) {
                await previousContext.cleanup();
            }

            return {
                alias: trimmedAlias,
                model: getActiveModelName(this.config),
            };
        } catch (error) {
            if (nextContext) {
                await nextContext.cleanup().catch(() => undefined);
            }

            try {
                setActiveModelAlias(this.config, previousAlias);
            } catch {
                // ignore rollback errors and bubble original failure
            }

            this.agentContext = previousContext;
            throw error;
        }
    }

    async buildBootstrapMessages(options: BuildBootstrapMessagesOptions): Promise<Array<{ role: 'user'; content: string }>> {
        if (this.bootstrappedThreads.has(options.threadId)) {
            return [];
        }

        this.bootstrappedThreads.add(options.threadId);
        const bootstrapPromptMessage = await buildPromptBootstrapMessage({
            workspacePath: options.workspacePath,
            scopeKey: options.scopeKey,
        });

        if (!bootstrapPromptMessage) {
            return [];
        }

        return [bootstrapPromptMessage];
    }

    clearBootstrapFlag(threadId: string): void {
        this.bootstrappedThreads.delete(threadId);
    }

    private async createAgentContext(): Promise<AgentContext> {
        const createOptions: CreateAgentOptions = {
            runtimeChannel: this.runtimeChannel,
            checkpointer: this.checkpointer,
        };

        if (this.execApprovalPrompt) {
            createOptions.execApprovalPrompt = this.execApprovalPrompt;
        }

        return createAgent(this.config, createOptions);
    }
}
