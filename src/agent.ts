import {
    createDeepAgent,
    FilesystemBackend,
} from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { loadConfig, type Config } from './config.js';
import { loadMemoryContext, createMemoryTools } from './middleware/index.js';
import { getSubagents } from './subagents/index.js';
import { runCommand, type ExecAuditMetadata } from './tools/exec.js';
import { checkCommandPolicy, type CommandRiskLevel, type PolicyStatus } from './tools/exec-policy.js';
import { writeExecAuditEvent, type ExecAuditEventType } from './audit/logger.js';
import { initializeMCPTools } from './mcp.js';
import { createChatModel } from './llm.js';
import { createCronTools } from './cron/tools.js';
import { createDingTalkFileReturnTools } from './channels/dingtalk/file-return-tools.js';
import { createWebFileReturnTools } from './channels/web/file-return-tools.js';
import {
    buildEnvWithCredentialFallback,
    enterTemporaryCredentialEnv,
    withTemporaryCredentialEnv,
} from './security/credential-env.js';
import { redactSensitiveText } from './security/redaction.js';

// Define return type to avoid complex type inference issues
export interface RuntimeAgentInvokeResult {
    messages?: Array<{ content?: unknown }>;
    [key: string]: unknown;
}

export interface RuntimeAgentStreamEvent {
    event: string;
    name?: string;
    data?: {
        chunk?: {
            content?: string | Array<{ type?: string; text?: string }>;
        };
        output?: {
            messages?: unknown[];
        };
        messages?: unknown[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface RuntimeAgent {
    invoke: (input: unknown, options?: unknown) => Promise<RuntimeAgentInvokeResult>;
    streamEvents: (input: unknown, options?: unknown) => AsyncIterable<RuntimeAgentStreamEvent>;
}

export interface AgentContext {
    agent: RuntimeAgent;
    config: Config;
    cleanup: () => Promise<void>;
}

export interface ExecApprovalMetadata {
    channel: 'cli' | 'dingtalk' | 'system';
    callId: string;
    approvalId?: string;
    cardInstanceId?: string;
    decisionSource?: 'cli' | 'text' | 'button' | 'system';
    approverId?: string;
    approverName?: string;
    decidedAt?: string;
}

export interface ExecApprovalRequest {
    callId: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    policyStatus: PolicyStatus;
    policyReason?: string;
    riskLevel: CommandRiskLevel;
    riskReasons: string[];
}

export type ExecApprovalDecision = {
    decision: 'approve' | 'reject' | 'edit';
    command?: string;
    comment?: string;
    metadata?: ExecApprovalMetadata;
};

export type ExecApprovalPrompt = (request: ExecApprovalRequest) => Promise<ExecApprovalDecision>;

export type AgentRuntimeChannel = 'cli' | 'dingtalk' | string;

export interface CreateAgentOptions {
    execApprovalPrompt?: ExecApprovalPrompt;
    runtimeChannel?: AgentRuntimeChannel;
    checkpointer?: MemorySaver;
}

function toSingleLineDescription(description: string | undefined): string {
    if (!description) return '';
    const normalized = description.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    const sentence = normalized.split(/(?<=[。.!?])\s+/u)[0]?.trim() || normalized;
    return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence;
}

function buildToolSummaryLines(
    tools: Array<{ name?: string; description?: string }>
): string[] {
    const seen = new Set<string>();
    const lines: string[] = [];

    for (const toolItem of tools) {
        const name = (toolItem.name || '').trim();
        if (!name || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const desc = toSingleLineDescription(toolItem.description);
        lines.push(desc ? `- ${name}: ${desc}` : `- ${name}`);
    }

    return lines.length > 0 ? lines : ['- 当前未发现可用工具'];
}

async function persistExecAudit(
    type: ExecAuditEventType,
    callId: string,
    data: Record<string, unknown>
): Promise<void> {
    try {
        await writeExecAuditEvent({
            timestamp: new Date().toISOString(),
            type,
            callId,
            data,
        });
    } catch (error) {
        console.warn(
            `[ExecAudit] Failed to write audit log (type=${type}, callId=${callId}):`,
            error instanceof Error ? error.message : String(error)
        );
    }
}

function formatApprovalMeta(metadata?: ExecApprovalMetadata, comment?: string): string | null {
    if (!metadata && !comment) return null;
    const lines = ['- approval:'];
    if (metadata) {
        lines.push(
            `  channel=${metadata.channel}`,
            `  callId=${metadata.callId}`,
            `  approvalId=${metadata.approvalId || 'n/a'}`,
            `  cardInstanceId=${metadata.cardInstanceId || 'n/a'}`,
            `  source=${metadata.decisionSource || 'n/a'}`,
            `  approver=${metadata.approverName || metadata.approverId || 'n/a'}`,
            `  decidedAt=${metadata.decidedAt || new Date().toISOString()}`
        );
    }
    if (comment) {
        lines.push(`  comment=${redactSensitiveText(comment)}`);
    }
    return lines.join('\n');
}

function formatExecAudit(metadata: ExecAuditMetadata, approval?: ExecApprovalDecision): string {
    const lines = [
        '🧾 Exec 审计',
        `- callId: ${metadata.callId}`,
        `- command: ${redactSensitiveText(metadata.command)}`,
        `- baseCommand: ${metadata.baseCommand || 'n/a'}`,
        `- cwd: ${metadata.cwd}`,
        `- shell: ${String(metadata.shell)}`,
        `- pid/ppid: ${metadata.pid ?? 'n/a'}/${metadata.ppid}`,
        `- policy: ${metadata.policyStatus} (${metadata.policyMode})`,
        `- risk: ${metadata.riskLevel}${metadata.riskReasons.length ? ` | ${metadata.riskReasons.join('; ')}` : ''}`,
        `- startedAt: ${metadata.startedAt}`,
        `- finishedAt: ${metadata.finishedAt}`,
        `- durationMs: ${metadata.durationMs}`,
        `- exitCode: ${metadata.exitCode ?? 'n/a'}${metadata.signal ? ` | signal=${metadata.signal}` : ''}`,
        `- timedOut: ${String(metadata.timedOut)}`,
        `- truncated: stdout=${String(metadata.stdoutTruncated)}, stderr=${String(metadata.stderrTruncated)}`,
    ];
    const approvalMeta = formatApprovalMeta(approval?.metadata, approval?.comment);
    if (approvalMeta) {
        lines.push(approvalMeta);
    }
    return lines.join('\n');
}

function wrapAgentWithCredentialEnv(agent: RuntimeAgent): RuntimeAgent {
    return {
        invoke: (input: unknown, options?: unknown) =>
            withTemporaryCredentialEnv(() => agent.invoke(input, options)),
        streamEvents: (input: unknown, options?: unknown) =>
            (async function* streamWithCredentialEnv() {
                const release = await enterTemporaryCredentialEnv();
                try {
                    for await (const event of agent.streamEvents(input, options)) {
                        yield event;
                    }
                } finally {
                    release();
                }
            })(),
    };
}

/**
 * Create exec tool with policy enforcement
 */
function createExecTool(config: Config, execApprovalPrompt?: ExecApprovalPrompt) {
    const execConfig = config.exec;
    const approvalsEnabled = execConfig.approvals.enabled || Boolean(execApprovalPrompt);

    return tool(
        async ({ command, cwd, timeoutMs }) => {
            const callId = `call_${randomUUID().slice(0, 8)}`;
            let finalCommand = command;
            const finalCwd = cwd || process.cwd();
            const finalTimeout = timeoutMs ?? execConfig.defaultTimeoutMs;
            let approvalDecision: ExecApprovalDecision | undefined;

            let policy = checkCommandPolicy(finalCommand, execConfig);

            if (policy.status === 'disabled') {
                await persistExecAudit('policy_denied', callId, {
                    command: finalCommand,
                    cwd: finalCwd,
                    timeoutMs: finalTimeout,
                    reason: 'Exec tool is disabled in configuration',
                    policyStatus: policy.status,
                    riskLevel: policy.risk.level,
                    riskReasons: policy.risk.reasons,
                });
                return `❌ Exec 功能已关闭 (callId=${callId})`;
            }

            if (policy.status === 'denied') {
                await persistExecAudit('policy_denied', callId, {
                    command: finalCommand,
                    cwd: finalCwd,
                    timeoutMs: finalTimeout,
                    reason: policy.reason,
                    policyStatus: policy.status,
                    riskLevel: policy.risk.level,
                    riskReasons: policy.risk.reasons,
                });
                return `❌ Command not allowed (callId=${callId}): ${policy.reason || 'Denied by policy'}`;
            }

            const requiresApproval = policy.status === 'unknown' || policy.requiresApproval;
            if (requiresApproval) {
                if (!approvalsEnabled) {
                    await persistExecAudit('approval_required_but_disabled', callId, {
                        command: finalCommand,
                        cwd: finalCwd,
                        timeoutMs: finalTimeout,
                        policyStatus: policy.status,
                        policyReason: policy.reason,
                        riskLevel: policy.risk.level,
                        riskReasons: policy.risk.reasons,
                    });
                    return `❌ Command requires approval but approvals are disabled (callId=${callId}). ${policy.reason || ''}`.trim();
                }
                if (!execApprovalPrompt) {
                    await persistExecAudit('approval_required_but_disabled', callId, {
                        command: finalCommand,
                        cwd: finalCwd,
                        timeoutMs: finalTimeout,
                        policyStatus: policy.status,
                        policyReason: policy.reason,
                        riskLevel: policy.risk.level,
                        riskReasons: policy.risk.reasons,
                        reason: 'Approval prompt channel not configured',
                    });
                    return '❌ Exec 审批已开启，但未配置可用的审批通道';
                }

                const approval = await execApprovalPrompt({
                    callId,
                    command: finalCommand,
                    cwd: finalCwd,
                    timeoutMs: finalTimeout,
                    policyStatus: policy.status,
                    policyReason: policy.reason,
                    riskLevel: policy.risk.level,
                    riskReasons: policy.risk.reasons,
                });
                approvalDecision = approval;
                await persistExecAudit('approval_decision', callId, {
                    originalCommand: command,
                    commandBeforeDecision: finalCommand,
                    decision: approval.decision,
                    comment: approval.comment,
                    approval: approval.metadata || null,
                    policyStatus: policy.status,
                    policyReason: policy.reason,
                    riskLevel: policy.risk.level,
                    riskReasons: policy.risk.reasons,
                    cwd: finalCwd,
                    timeoutMs: finalTimeout,
                });

                if (approval.decision === 'reject') {
                    const rejectedBy = approval.metadata?.approverName || approval.metadata?.approverId || approval.metadata?.channel || 'approval';
                    const comment = approval.comment ? `，原因: ${approval.comment}` : '';
                    return `❌ 已拒绝执行命令 (callId=${callId}, by=${rejectedBy}${comment})`;
                }

                if (approval.decision === 'edit' && approval.command?.trim()) {
                    finalCommand = approval.command.trim();
                }

                // Re-evaluate policy after approval edits
                policy = checkCommandPolicy(finalCommand, execConfig);
                if (policy.status === 'denied' || policy.status === 'disabled') {
                    await persistExecAudit('policy_denied', callId, {
                        command: finalCommand,
                        cwd: finalCwd,
                        timeoutMs: finalTimeout,
                        reason: policy.reason,
                        policyStatus: policy.status,
                        riskLevel: policy.risk.level,
                        riskReasons: policy.risk.reasons,
                        afterApprovalEdit: true,
                    });
                    return `❌ Command not allowed after approval review (callId=${callId}): ${policy.reason || 'Denied by policy'}`;
                }
            }

            console.log(`[ExecTool] [${callId}] Executing command: ${redactSensitiveText(finalCommand)}`);

            const result = await runCommand(finalCommand, execConfig, {
                cwd: finalCwd,
                timeoutMs: finalTimeout,
                env: buildEnvWithCredentialFallback(),
                policyMode: policy.status === 'unknown' ? 'deny-only' : 'enforce',
                callId,
            });
            await persistExecAudit('exec_result', callId, {
                success: result.success,
                error: result.error,
                timedOut: result.timedOut ?? false,
                metadata: result.metadata,
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
                stdoutPreview: result.stdout ? result.stdout.slice(0, 500) : '',
                stderrPreview: result.stderr ? result.stderr.slice(0, 500) : '',
                approval: approvalDecision?.metadata || null,
            });

            const audit = formatExecAudit(result.metadata, approvalDecision);
            if (!result.success) {
                const parts = [`❌ Command failed: ${result.error || 'Unknown error'}`];
                if (result.stderr) {
                    parts.push(`⚠️ Stderr:\n${result.stderr}`);
                }
                if (result.stdout) {
                    parts.push(`📤 Partial Output:\n${result.stdout}`);
                }
                parts.push(audit);
                return parts.join('\n\n');
            }

            const parts: string[] = ['✅ Command executed successfully'];
            if (result.stdout) {
                parts.push(`📤 Output:\n${result.stdout}`);
            }
            if (result.stderr) {
                parts.push(`⚠️ Stderr:\n${result.stderr}`);
            }
            if (!result.stdout && !result.stderr) {
                parts.push('（无输出）');
            }
            parts.push(audit);

            return parts.join('\n\n');
        },
        {
            name: 'exec_command',
            description: `执行本地系统命令。只允许执行白名单中的命令。
            
允许的命令: ${execConfig.allowedCommands.join(', ')}
禁止的命令: ${execConfig.deniedCommands.join(', ')}

使用此工具时:
- 只执行安全、只读的命令
- 优先使用安全参数
- 不要尝试执行破坏性命令`,
            schema: z.object({
                command: z.string().describe('要执行的完整命令（包括参数），例如: "ls -la" 或 "kubectl get pods"'),
                cwd: z.string().optional().describe('命令执行的工作目录，默认为当前目录'),
                timeoutMs: z.number().optional().describe('命令超时时间（毫秒），默认30000ms'),
            }),
        }
    );
}

/**
 * Create the main Agent with memory, skills, and subagents
 */
export async function createSREAgent(
    config?: Config,
    options?: CreateAgentOptions,
): Promise<AgentContext> {
    const cfg = config || loadConfig();
    const execApprovalPrompt = options?.execApprovalPrompt;
    const runtimeChannel = options?.runtimeChannel || 'cli';
    const enableDingTalkTools = runtimeChannel === 'dingtalk';
    const enableWebTools = runtimeChannel === 'web';
    const workspacePath = resolve(process.cwd(), cfg.agent.workspace);
    const skillsPath = resolve(process.cwd(), cfg.agent.skills_dir);

    // Create OpenAI model
    const model = await createChatModel(cfg, { temperature: 0 });

    // Create checkpointer for conversation persistence
    const checkpointer = options?.checkpointer || new MemorySaver();

    // Get subagents
    const subagents = getSubagents(cfg);

    // Create memory tools
    const memoryTools = createMemoryTools(workspacePath, cfg);

    // Create exec tool
    const execTool = createExecTool(cfg, execApprovalPrompt);

    // Create MCP tools
    const mcpBootstrap = await initializeMCPTools(cfg);
    const mcpTools = mcpBootstrap.tools;
    const cronTools = createCronTools(cfg);
    const dingtalkToolLogger = enableDingTalkTools
        ? {
            debug: (message: string, ...args: unknown[]) => console.debug(message, ...args),
            info: (message: string, ...args: unknown[]) => console.info(message, ...args),
            warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
            error: (message: string, ...args: unknown[]) => console.error(message, ...args),
        }
        : undefined;
    const dingtalkFileTools = enableDingTalkTools
        ? createDingTalkFileReturnTools(workspacePath, cfg.dingtalk, dingtalkToolLogger)
        : [];
    const webToolLogger = enableWebTools
        ? {
            debug: (message: string, ...args: unknown[]) => console.debug(message, ...args),
            info: (message: string, ...args: unknown[]) => console.info(message, ...args),
            warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
            error: (message: string, ...args: unknown[]) => console.error(message, ...args),
        }
        : undefined;
    const webFileTools = enableWebTools
        ? createWebFileReturnTools(workspacePath, webToolLogger)
        : [];

    // Combine all tools
    const allTools = [...memoryTools, execTool, ...cronTools, ...dingtalkFileTools, ...webFileTools, ...mcpTools];

    // Load initial memory context for system prompt
    const memoryContext = loadMemoryContext(workspacePath);

    // System prompt with memory context
    const toolSummaryLines = buildToolSummaryLines(allTools as Array<{ name?: string; description?: string }>);
    const mcpServersHint = mcpBootstrap.serverNames.length > 0
        ? `## MCP 服务器\n${mcpBootstrap.serverNames.map((name) => `- ${name}`).join('\n')}\n`
        : '';
    const channelWorkspaceRules = enableDingTalkTools
        ? [
            '- 需要生成并回传给 DingTalk 的文件，统一写到 workspace/tmp。',
            '- 需要回传附件时，优先调用 dingtalk_write_tmp_file / dingtalk_send_file，不要依赖回复文本标签触发。',
        ]
        : enableWebTools
            ? [
                '- 需要生成并回传给 Web UI 的文件，统一写到 workspace/tmp。',
                '- 需要回传附件时，优先调用 web_write_tmp_file / web_send_file，不要只在正文里写文件路径。',
            ]
            : [
            '- 需要生成附件时，统一写到 workspace/tmp；具体回传由接入渠道适配层处理。',
            ];

    const systemPrompt = `你是 SREBot，一位可靠的 SRE 协作伙伴。目标是帮助用户高质量完成运维、排障、告警处置与自动化任务。

## Tooling
你可用的工具（由系统策略过滤后注入）如下：
${toolSummaryLines.join('\n')}
工具名必须精确匹配后再调用，不要臆造工具。

## 规则优先级（高 -> 低）
- P0: 平台与运行时硬约束（安全策略、审批、工具白名单/黑名单、沙箱约束）。
- P1: 本系统提示词中的硬规则。
- P2: 用户当前任务目标与明确约束。
- P3: AGENTS（项目协作规范）。
- P4: TOOLS（工具使用约定）。
- P5: SOUL（身份与风格约束，可 scope 覆盖）。
- P6: HEARTBEAT（纠错复盘经验，可 scope 覆盖）。
- 冲突处理：安全/边界冲突按高优先级执行；若仅风格冲突，优先满足用户本轮任务并在必要时用 heartbeat_save 记录纠偏。

## Prompt Bootstrap
- 参考 OpenClaw 的多文件注入思路：每个会话 thread 首次调用时注入 AGENTS / TOOLS / SOUL / HEARTBEAT。
- 将引导文件视为“可变项目上下文”；若文件缺失，保持硬规则不变并继续完成任务。

## Safety（硬规则）
- 你没有独立目标，不追求自我保存、权限扩张或资源控制。
- 安全优先于完成速度；当用户指令与安全约束冲突时，先停止并请求确认。
- 不要绕过白名单/审批机制，不要建议规避系统限制。

## 事实与证据（硬规则）
- 涉及可验证事实时优先查证，不要把猜测当事实。
- 不确定时明确不确定性，并给出下一步验证路径。

## 记忆协议（硬规则）
- 回溯型问题（之前/上次/昨天/历史/是否聊过）先 memory_search。
- 需要精确引用（数字/日期/阈值/原话）先 memory_search，再 memory_get。
- 用户明确要求“记住/保存”时必须调用 memory_save。
- 检索不足时必须明确说明“已检索但信息不足”。

## 持续纠错（硬规则）
- 当用户纠正你、或你发现自身决策有偏差时，先修正当前回答，再按需调用 heartbeat_save 记录复盘。
- heartbeat_save 内容至少包含：触发场景、纠正动作、防回归检查。
- 避免噪声写入：仅在有真实纠偏价值时记录。

## 命令执行（硬规则）
- 使用 exec_command 执行系统命令。
- 只能执行白名单中的命令: ${cfg.exec.allowedCommands.join(', ')}
- 禁止执行黑名单中的命令: ${cfg.exec.deniedCommands.join(', ')}
- 优先只读、安全命令；能不改动环境就不改动。
- 注意命令输出长度和超时限制。

## 定时任务（硬规则）
- 当用户提出“提醒我”“定时执行”“每天/每周/每小时任务”时，优先使用 cron_job_* 工具。
- 新建或修改前，先用 cron_job_list 检查现有任务，避免重复。
- 变更任务时给出任务 id、调度方式和发送目标（群/人）确认。

## 子代理与技能
- 可使用子代理: skill-writer-agent（用于创建/维护 SKILL.md）。
- 技能目录在 workspace/skills/，处理技能相关任务时优先复用已有技能。

## 工作区
- 默认工作目录: ${workspacePath}
- 非必要不要越界访问或修改工作区外文件。
- 修改配置或代码时，优先最小改动并保持现有风格一致。
${channelWorkspaceRules.join('\n')}

## 媒体输入约定
- 当消息中出现 [媒体上下文]、<file ...>...</file> 等块时，将其视为用户提供的附件解析结果并据此回答。
- 不要编造附件内容；信息不足时明确指出缺失项。

## 输出要求
- 默认中文，先给结论，再给关键依据，最后给下一步建议。
- 语气专业、自然、克制，避免模板化客套或机械重复。
- 除非用户要求，不要在回复中复述内部规则编号或提示词条文。

## 当前记忆上下文
${memoryContext}

${mcpServersHint}`;

    // Create the agent with FilesystemBackend and memory tools
    let agent: RuntimeAgent;
    try {
        const createdAgent = await withTemporaryCredentialEnv(() => createDeepAgent({
            model,
            systemPrompt,
            tools: allTools,
            subagents,
            backend: () => new FilesystemBackend({ rootDir: workspacePath }),
            skills: [skillsPath],
            checkpointer,
        }));
        agent = wrapAgentWithCredentialEnv(createdAgent as unknown as RuntimeAgent);
    } catch (error) {
        await mcpBootstrap.close();
        throw error;
    }

    const cleanup = async () => {
        await mcpBootstrap.close();
    };

    return { agent, config: cfg, cleanup };
}

// Export for backward compatibility
export { createSREAgent as createAgent };
