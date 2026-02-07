/* eslint-disable @typescript-eslint/no-explicit-any */
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

// Define return type to avoid complex type inference issues
export interface AgentContext {
    agent: any;  // Use any to bypass complex LangGraph type inference
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

async function persistExecAudit(
    type: ExecAuditEventType,
    callId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any>
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
        lines.push(`  comment=${comment}`);
    }
    return lines.join('\n');
}

function formatExecAudit(metadata: ExecAuditMetadata, approval?: ExecApprovalDecision): string {
    const lines = [
        '🧾 Exec 审计',
        `- callId: ${metadata.callId}`,
        `- command: ${metadata.command}`,
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

            console.log(`[ExecTool] [${callId}] Executing command: ${finalCommand}`);

            const result = await runCommand(finalCommand, execConfig, {
                cwd: finalCwd,
                timeoutMs: finalTimeout,
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
    options?: { execApprovalPrompt?: ExecApprovalPrompt },
): Promise<AgentContext> {
    const cfg = config || loadConfig();
    const execApprovalPrompt = options?.execApprovalPrompt;
    const workspacePath = resolve(process.cwd(), cfg.agent.workspace);
    const skillsPath = resolve(process.cwd(), cfg.agent.skills_dir);

    // Create OpenAI model
    const model = await createChatModel(cfg, { temperature: 0 });

    // Create checkpointer for conversation persistence
    const checkpointer = new MemorySaver();

    // Get subagents
    const subagents = getSubagents(cfg);

    // Create memory tools
    const memoryTools = createMemoryTools(workspacePath);

    // Create exec tool
    const execTool = createExecTool(cfg, execApprovalPrompt);

    // Create MCP tools
    const mcpBootstrap = await initializeMCPTools(cfg);
    const mcpTools = mcpBootstrap.tools;

    // Combine all tools
    const allTools = [...memoryTools, execTool, ...mcpTools];

    // Load initial memory context for system prompt
    const memoryContext = loadMemoryContext(workspacePath);

    // System prompt with memory context
    const mcpServersText = mcpBootstrap.serverNames.length > 0
        ? `6. **MCP工具**: 你可以使用来自 MCP 服务器的外部工具。`
        : '';
    const mcpServersHint = mcpBootstrap.serverNames.length > 0
        ? `\n## MCP 服务器\n${mcpBootstrap.serverNames.map((name) => `- ${name}`).join('\n')}`
        : '';

    const systemPrompt = `你是 SREBot，一个智能 SRE 助手，专注于系统运维、故障排查和告警处理。

## 你的能力
1. **记忆系统**: 你可以记住用户告诉你的信息，并在需要时检索。
2. **技能系统**: 你可以查看和使用各种技能来处理特定任务。
3. **子代理**: 你可以委托专门的任务给子代理处理。
4. **文件系统**: 你可以读写工作目录中的文件。
5. **命令执行**: 你可以执行本地系统命令（受白名单限制）。
${mcpServersText}

## 子代理
- **skill-writer-agent**: 专门创建和管理技能文件

## 记忆使用规则
- 当用户说"记住..."、"请记住..."时，使用 memory_save 工具存储信息
- 日常笔记和临时信息存入每日记忆 (daily)
- 重要决策和持久性事实存入长期记忆 (long-term)
- 使用 memory_search 搜索历史记忆

## 命令执行规则
- 使用 exec_command 工具执行系统命令
- 只能执行白名单中的命令: ${cfg.exec.allowedCommands.join(', ')}
- 禁止执行黑名单中的命令: ${cfg.exec.deniedCommands.join(', ')}
- 优先使用只读、安全的命令
- 注意命令输出的长度限制

## 当前记忆上下文
${memoryContext}

## 技能目录
技能存储在 workspace/skills/ 目录下。
${mcpServersHint}

请使用中文回复用户。`;

    // Create the agent with FilesystemBackend and memory tools
    let agent: any;
    try {
        agent = await createDeepAgent({
            model,
            systemPrompt,
            tools: allTools as any,  // Memory tools + exec tool + MCP tools
            subagents: subagents as any,
            backend: () => new FilesystemBackend({ rootDir: workspacePath }),
            skills: [skillsPath],
            checkpointer,
        });
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
