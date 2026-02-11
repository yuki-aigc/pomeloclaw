import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import crypto from 'node:crypto';
import { resolve } from 'node:path';

import { createAgent } from './agent.js';
import type { ExecApprovalPrompt, ExecApprovalRequest, ExecApprovalDecision } from './agent.js';
import { loadConfig } from './config.js';
import {
    createChatModel,
    getActiveModelAlias,
    getActiveModelEntry,
    getActiveModelName,
    hasModelAlias,
    listConfiguredModels,
    setActiveModelAlias,
} from './llm.js';
import {
    estimateTotalTokens,
    shouldAutoCompact,
    getContextUsageInfo,
    formatTokenCount,
    compactMessages,
} from './compaction/index.js';
import { parseCommand, handleCommand, type CommandContext } from './commands/index.js';
import {
    createMemoryFlushState,
    estimateTokens,
    updateTokenCount,
    shouldTriggerMemoryFlush,
    markFlushCompleted,
    isNoReplyResponse,
    getTokenUsageInfo,
    buildMemoryFlushPrompt,
    recordSessionTranscript,
    type MemoryFlushState,
} from './middleware/index.js';

// ANSI terminal colors
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    orange: '\x1b[38;5;208m',
    black: '\x1b[30m',
    magenta: '\x1b[35m',
};

/**
 * Format markdown syntax in terminal output
 * - # Header -> bold yellow
 * - ## Header -> bold white
 * - **text** -> bold text
 * - `text` -> cyan highlighted text
 * - - list item -> with bullet
 */
function formatMarkdown(text: string): string {
    let result = text;

    // Handle headers - must be at start of line
    // # Header -> bold yellow
    if (result.match(/^#{1}\s+/)) {
        result = result.replace(/^#\s+(.*)$/, `${colors.bright}${colors.yellow}$1${colors.reset}`);
    }
    // ## Header -> bold white
    else if (result.match(/^#{2,}\s+/)) {
        result = result.replace(/^#{2,}\s+(.*)$/, `${colors.bright}${colors.white}$1${colors.reset}`);
    }

    // Replace **bold** with bright/bold text
    result = result.replace(/\*\*([^*]+)\*\*/g, `${colors.bright}${colors.white}$1${colors.reset}`);

    // Replace `code` with cyan text
    result = result.replace(/`([^`]+)`/g, `${colors.cyan}$1${colors.reset}`);

    // Replace list items - at start of line
    result = result.replace(/^(\s*)-\s+/, `$1${colors.cyan}•${colors.reset} `);

    // Replace numbered list items
    result = result.replace(/^(\s*)(\d+)\.\s+/, `$1${colors.cyan}$2.${colors.reset} `);

    return result;
}

/**
 * Print the header
 */
function printHeader(config: ReturnType<typeof loadConfig>) {
    const cwd = process.cwd();
    const model = getActiveModelName(config);

    const o = colors.orange;
    const r = colors.reset;
    const g = colors.gray;
    const b = colors.bright;
    const rd = colors.red;

    console.log();
    console.log(`     ${o}▄▄▄▄▄${r}        ${b}SRE Bot${r} ${g}v1.0.0${r}`);
    console.log(`   ${o}█ ${r}●   ●${o} █      ${g}${model}${r} ${g}· API Usage Billing${r}`);
    console.log(`   ${o}█ ${rd}      ${o}█      ${g}Memory & Skills Enabled${r}`);
    console.log(`    ${o}▀▀▀▀▀▀▀${r}       ${g}${cwd}${r}`);
    console.log(`     ${g}▀   ▀${r}`);
    console.log();
    console.log(` ${g}Welcome to SRE Bot. Type "/help" for commands, "exit" to quit.${r}\n`);
}

function maskApiKey(apiKey: string): string {
    if (!apiKey) return '(not set)';
    if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}...${apiKey.slice(-2)}`;
    return `${apiKey.slice(0, 6)}...${apiKey.slice(-6)}`;
}

async function main() {
    const config = loadConfig();
    const approvalsEnabled = config.exec.approvals.enabled;
    const execApprovalPrompt: ExecApprovalPrompt | undefined = approvalsEnabled
        ? async (request: ExecApprovalRequest): Promise<ExecApprovalDecision> => {
            console.log();
            console.log(`${colors.yellow}● Exec 审批${colors.reset}`);
            console.log(`${colors.gray}调用ID:${colors.reset} ${request.callId}`);
            console.log(`${colors.gray}命令:${colors.reset} ${request.command}`);
            console.log(`${colors.gray}目录:${colors.reset} ${request.cwd}`);
            console.log(`${colors.gray}超时:${colors.reset} ${request.timeoutMs}ms`);
            console.log(`${colors.gray}策略:${colors.reset} ${request.policyStatus}${request.policyReason ? ` (${request.policyReason})` : ''}`);
            if (request.riskReasons.length > 0) {
                console.log(`${colors.gray}风险:${colors.reset} ${request.riskLevel} - ${request.riskReasons.join('; ')}`);
            } else {
                console.log(`${colors.gray}风险:${colors.reset} ${request.riskLevel}`);
            }

            const answer = (await rl.question(`${colors.yellow}允许执行?${colors.reset} (y=允许, n=拒绝, e=编辑) `))
                .trim()
                .toLowerCase();

            if (answer === 'e') {
                const edited = (await rl.question(`${colors.gray}输入新命令:${colors.reset} `)).trim();
                if (edited) {
                    return {
                        decision: 'edit',
                        command: edited,
                        metadata: {
                            channel: 'cli',
                            callId: request.callId,
                            decisionSource: 'cli',
                            approverName: process.env.USER || 'local-cli',
                            decidedAt: new Date().toISOString(),
                        },
                    };
                }
            }

            if (answer === 'y' || answer === 'yes') {
                return {
                    decision: 'approve',
                    metadata: {
                        channel: 'cli',
                        callId: request.callId,
                        decisionSource: 'cli',
                        approverName: process.env.USER || 'local-cli',
                        decidedAt: new Date().toISOString(),
                    },
                };
            }

            const rejectComment = (await rl.question(`${colors.gray}拒绝原因(可选):${colors.reset} `)).trim();
            console.log(`${colors.red}已拒绝执行命令${colors.reset}`);
            return {
                decision: 'reject',
                comment: rejectComment || undefined,
                metadata: {
                    channel: 'cli',
                    callId: request.callId,
                    decisionSource: 'cli',
                    approverName: process.env.USER || 'local-cli',
                    decidedAt: new Date().toISOString(),
                },
            };
        }
        : undefined;

    const initialAgentContext = await createAgent(config, {
        execApprovalPrompt,
        runtimeChannel: 'cli',
    });
    let agent = initialAgentContext.agent;
    let cleanup = initialAgentContext.cleanup;

    // Create model instance for compaction
    let compactionModel = await createChatModel(config, { temperature: 0 });

    printHeader(config);

    const rl = createInterface({ input, output });

    // Session state
    let threadId = `thread-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    let sessionStartTime = new Date();
    let lastUpdatedAt = new Date();
    let messageHistory: import('@langchain/core/messages').BaseMessage[] = [];
    let flushState: MemoryFlushState = createMemoryFlushState();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let hasConversation = false;
    const memoryWorkspacePath = resolve(process.cwd(), config.agent.workspace);
    const appVersion = process.env.npm_package_version || '1.0.0';

    const getAgentConfig = () => ({
        configurable: { thread_id: threadId },
        recursionLimit: config.agent.recursion_limit,
    });

    const getCommandContext = (): CommandContext => {
        const active = getActiveModelEntry(config);
        return {
            model: compactionModel,
            config: config.agent.compaction,
            currentTokens: flushState.totalTokens,
            totalInputTokens,
            totalOutputTokens,
            compactionCount: flushState.flushCount,
            threadId,
            sessionStartTime,
            lastUpdatedAt,
            appVersion,
            activeModelAlias: getActiveModelAlias(config),
            activeModel: {
                alias: active.alias,
                provider: active.provider,
                model: active.model,
            },
            activeModelApiKeyMasked: maskApiKey(active.api_key),
            runtimeMode: 'direct',
            thinkLevel: 'low',
            queueName: 'collect',
            queueDepth: 0,
            modelOptions: listConfiguredModels(config).map((item) => ({
                alias: item.alias,
                provider: item.provider,
                model: item.model,
            })),
        };
    };

    async function switchModel(alias: string): Promise<string> {
        const trimmedAlias = alias.trim();
        if (!trimmedAlias) {
            return '❌ 模型别名不能为空。';
        }
        if (!hasModelAlias(config, trimmedAlias)) {
            return `❌ 未找到模型别名: ${trimmedAlias}`;
        }

        const previousAlias = getActiveModelAlias(config);
        if (trimmedAlias === previousAlias) {
            return `ℹ️ 当前已在使用模型: ${trimmedAlias}`;
        }

        let nextCleanup: (() => Promise<void>) | null = null;
        try {
            setActiveModelAlias(config, trimmedAlias);
            const nextAgentContext = await createAgent(config, {
                execApprovalPrompt,
                runtimeChannel: 'cli',
            });
            nextCleanup = nextAgentContext.cleanup;
            const nextCompactionModel = await createChatModel(config, { temperature: 0 });

            const oldCleanup = cleanup;
            agent = nextAgentContext.agent;
            cleanup = nextAgentContext.cleanup;
            compactionModel = nextCompactionModel;

            try {
                await oldCleanup();
            } catch (error) {
                console.warn(`${colors.yellow}[MCP] previous agent cleanup failed:${colors.reset}`, error instanceof Error ? error.message : String(error));
            }

            return `✅ 已切换模型: ${trimmedAlias} (${getActiveModelName(config)})`;
        } catch (error) {
            if (nextCleanup) {
                try {
                    await nextCleanup();
                } catch {
                    // ignore cleanup errors on failed switch
                }
            }
            try {
                setActiveModelAlias(config, previousAlias);
            } catch {
                // ignore rollback failure and report original switch error
            }
            return `❌ 切换模型失败: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Execute memory flush - save conversation summary to memory file
     */
    async function executeMemoryFlush(options?: { preserveTokenCount?: boolean }): Promise<void> {
        process.stdout.write(`${colors.gray}● ${colors.reset}${colors.dim}Saving memory...${colors.reset}`);
        const tokensBeforeFlush = flushState.totalTokens;

        try {
            const result = await agent.invoke(
                {
                    messages: [
                        { role: 'user', content: buildMemoryFlushPrompt() },
                    ],
                },
                {
                    ...getAgentConfig(),
                    recursionLimit: 10,
                }
            );

            const messages = result.messages;
            if (Array.isArray(messages) && messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                const content = typeof lastMessage.content === 'string' ? lastMessage.content : '';

                process.stdout.write(isNoReplyResponse(content) ? ` ${colors.green}✓${colors.reset}\n` : ` ${colors.gray}(saved)${colors.reset}\n`);
            }

            flushState = markFlushCompleted(flushState);
            if (options?.preserveTokenCount) {
                flushState = {
                    ...flushState,
                    totalTokens: tokensBeforeFlush,
                    lastFlushTokens: tokensBeforeFlush,
                };
            }
        } catch (error) {
            process.stdout.write(` ${colors.red}✗${colors.reset}\n`);
            console.error(`${colors.red}Error during memory flush:${colors.reset}`, error instanceof Error ? error.message : error);
        }
    }

    /**
     * Execute auto-compaction if needed (with memory flush first)
     */
    async function executeAutoCompact(): Promise<void> {
        const tokensBeforeAutoCompact = flushState.totalTokens;

        // First: flush memory to save important info
        if (shouldTriggerMemoryFlush(flushState, config.agent.compaction)) {
            await executeMemoryFlush({ preserveTokenCount: true });
        }

        if (!shouldAutoCompact(tokensBeforeAutoCompact, config.agent.compaction)) {
            return;
        }

        // Then: compact context
        process.stdout.write(`${colors.gray}● ${colors.reset}${colors.dim}Auto-compacting context...${colors.reset}`);

        try {
            const maxTokens = Math.floor(config.agent.compaction.context_window * config.agent.compaction.max_history_share);
            const result = await compactMessages(messageHistory, compactionModel, maxTokens);

            messageHistory = result.messages;
            flushState = markFlushCompleted(flushState);
            flushState = { ...flushState, totalTokens: result.tokensAfter };

            const saved = result.tokensBefore - result.tokensAfter;
            process.stdout.write(` ${colors.green}✓${colors.reset} (${formatTokenCount(saved)} saved)\n`);
        } catch (error) {
            process.stdout.write(` ${colors.red}✗${colors.reset}\n`);
            console.error(`${colors.red}Error during compaction:${colors.reset}`, error instanceof Error ? error.message : error);
        }
    }

    /**
     * Reset session for /new command
     */
    function resetSession(newThreadId: string): void {
        threadId = newThreadId;
        sessionStartTime = new Date();
        lastUpdatedAt = new Date();
        messageHistory = [];
        flushState = createMemoryFlushState();
        totalInputTokens = 0;
        totalOutputTokens = 0;
        hasConversation = false;
    }

    let isExiting = false;

    /**
     * Graceful exit with memory flush
     */
    async function gracefulExit(): Promise<void> {
        if (isExiting) return;
        isExiting = true;

        if (config.agent.compaction.enabled && hasConversation && flushState.totalTokens > 0) {
            console.log();
            await executeMemoryFlush();
        }

        try {
            await cleanup();
        } catch (error) {
            console.warn(`${colors.yellow}[MCP] cleanup failed:${colors.reset}`, error instanceof Error ? error.message : String(error));
        }

        console.log(`\n${colors.gray}Goodbye! 👋${colors.reset}`);
        rl.close();
        process.exit(0);
    }

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
        gracefulExit().catch(console.error);
    });

    // Also handle readline close event (e.g., when terminal is closed)
    rl.on('close', () => {
        if (!isExiting) {
            gracefulExit().catch(console.error);
        }
    });

    try {
        while (true) {
            const userPromptText = `${colors.gray}❯ ${colors.reset}`;
            const userInput = (await rl.question(userPromptText)).trim();

            if (!userInput) {
                continue;
            }
            lastUpdatedAt = new Date();

            if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
                await gracefulExit();
                break;
            }

            // Check for slash commands
            if (userInput.startsWith('/')) {
                const result = await handleCommand(userInput, getCommandContext(), messageHistory);

                if (result.handled) {
                    let responseText = result.response || '';

                    if (result.action === 'new_session' && result.newThreadId) {
                        // Flush memory before starting new session
                        if (hasConversation && flushState.totalTokens > 0) {
                            await executeMemoryFlush();
                        }
                        resetSession(result.newThreadId);
                    } else if (result.action === 'compact') {
                        // Flush memory then compact once
                        if (hasConversation && flushState.totalTokens > 0) {
                            await executeMemoryFlush();
                        }
                        try {
                            const maxTokens = Math.floor(config.agent.compaction.context_window * config.agent.compaction.max_history_share);
                            const compactResult = await compactMessages(
                                messageHistory,
                                compactionModel,
                                maxTokens,
                                result.compactInstructions,
                            );
                            messageHistory = compactResult.messages;
                            flushState = markFlushCompleted(flushState);
                            flushState = { ...flushState, totalTokens: compactResult.tokensAfter };

                            const saved = compactResult.tokensBefore - compactResult.tokensAfter;
                            responseText = saved > 0
                                ? `🧹 上下文压缩完成。\n` +
                                `压缩前: ${formatTokenCount(compactResult.tokensBefore)}\n` +
                                `压缩后: ${formatTokenCount(compactResult.tokensAfter)}\n` +
                                `节省: ${formatTokenCount(saved)} tokens`
                                : `ℹ️ 当前上下文较短，无需压缩。\n${getContextUsageInfo(compactResult.tokensAfter, config.agent.compaction)}`;
                        } catch (error) {
                            responseText = `❌ 压缩失败: ${error instanceof Error ? error.message : '未知错误'}`;
                        }
                    } else if (result.action === 'switch_model' && result.modelAlias) {
                        responseText = await switchModel(result.modelAlias);
                    }

                    console.log();
                    console.log(`${colors.white}● ${colors.reset}${responseText}`);
                    console.log();
                    console.log(`${colors.gray}${'━'.repeat(output.columns || 50)}${colors.reset}`);
                    console.log();
                    continue;
                }
            }

            hasConversation = true;
            flushState = updateTokenCount(flushState, userInput);
            totalInputTokens += estimateTokens(userInput);
            await recordSessionTranscript(memoryWorkspacePath, config, 'user', userInput)
                .catch(() => undefined);

            // Check auto-compact before processing
            await executeAutoCompact();

            try {
                console.log();
                process.stdout.write(`${colors.white}● ${colors.reset}`);

                let fullResponse = '';

                const eventStream = agent.streamEvents(
                    { messages: [{ role: 'user', content: userInput }] },
                    { ...getAgentConfig(), version: 'v2' }
                );

                let lineBuffer = '';  // Buffer for current line

                for await (const event of eventStream) {
                    if (event.event === 'on_chat_model_stream') {
                        const chunk = event.data?.chunk;
                        if (chunk?.content) {
                            let text = '';
                            if (typeof chunk.content === 'string') {
                                text = chunk.content;
                            } else if (Array.isArray(chunk.content)) {
                                for (const item of chunk.content) {
                                    if (item.type === 'text' && item.text) {
                                        text += item.text;
                                    }
                                }
                            }

                            fullResponse += text;

                            // Process character by character for line buffering
                            for (const char of text) {
                                if (char === '\n') {
                                    // End of line - format and output
                                    process.stdout.write(formatMarkdown(lineBuffer) + '\n');
                                    lineBuffer = '';
                                } else {
                                    lineBuffer += char;
                                }
                            }
                        }
                    } else if (event.event === 'on_tool_start') {
                        const toolName = event.name;
                        // Output any buffered content first
                        if (lineBuffer) {
                            process.stdout.write(formatMarkdown(lineBuffer));
                            lineBuffer = '';
                        }
                        process.stdout.write(`${colors.gray}[${toolName}]${colors.reset} `);
                    }
                }

                // Output any remaining buffered content
                if (lineBuffer) {
                    process.stdout.write(formatMarkdown(lineBuffer));
                }

                // Update token count and message history
                flushState = updateTokenCount(flushState, fullResponse);
                totalOutputTokens += estimateTokens(fullResponse);
                await recordSessionTranscript(memoryWorkspacePath, config, 'assistant', fullResponse)
                    .catch(() => undefined);
                lastUpdatedAt = new Date();
                const { HumanMessage, AIMessage } = await import('@langchain/core/messages');
                messageHistory.push(new HumanMessage(userInput));
                if (fullResponse) {
                    messageHistory.push(new AIMessage(fullResponse));
                }

                console.log();
                console.log(`${colors.gray}  ${getTokenUsageInfo(flushState, config.agent.compaction)}${colors.reset}`);

                // Check auto-compact after response
                await executeAutoCompact();

                console.log();
                console.log(`${colors.gray}${'━'.repeat(output.columns || 50)}${colors.reset}`);
                console.log();
            } catch (error) {
                console.error(`\n${colors.red}Error:${colors.reset}`, error instanceof Error ? error.message : error);
                console.log();
            }
        }
    } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
            throw error;
        }
    }

    rl.close();
}

main().catch(console.error);
