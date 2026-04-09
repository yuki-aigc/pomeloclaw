import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withChannelConversationContext } from '../channels/context.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { buildStructuredTeamMemoryContent, buildTeamMemoryContent, createMemoryTools } from './memory.js';

test('buildTeamMemoryContent annotates promoted records with source scope', () => {
    const content = buildTeamMemoryContent({
        content: '统一规范：查历史数据前先确认日期。',
        sourceScope: {
            key: 'group_ops',
            kind: 'group',
        },
        reason: '标准流程',
    });

    assert.match(content, /\[团队记忆晋升\]/);
    assert.match(content, /来源scope=group_ops/);
    assert.match(content, /晋升原因=标准流程/);
});

test('buildStructuredTeamMemoryContent renders normalized markdown sections', () => {
    const content = buildStructuredTeamMemoryContent({
        title: '查询历史数据前先确认日期',
        summary: '涉及时间窗口的查询前，必须先确认用户说的是哪一天。',
        applicability: '所有带“今天/昨天/上次”语义的数据查询。',
        steps: ['确认当前系统日期', '和用户确认目标日期', '再执行查询'],
        constraints: ['不要默认把“今天”理解成自然日零点到当前时间'],
        evidence: ['来自多次群聊排障复盘'],
        tags: ['查询流程', '时间语义'],
        sourceScope: {
            key: 'group_ops',
            kind: 'group',
        },
        reason: '标准流程',
    });

    assert.match(content, /## 团队记忆条目/);
    assert.match(content, /- 标题: 查询历史数据前先确认日期/);
    assert.match(content, /- 来源scopes: group_ops/);
    assert.match(content, /- 晋升原因: 标准流程/);
    assert.match(content, /### 操作步骤/);
    assert.match(content, /1\. 确认当前系统日期/);
    assert.match(content, /### 边界与注意事项/);
    assert.match(content, /### 证据与依据/);
});

test('memory_save_team promotes scoped memory into main long-term memory', async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'srebot-memory-tools-'));
    t.after(async () => {
        await rm(workspacePath, { recursive: true, force: true });
    });

    const config = structuredClone(DEFAULT_CONFIG);
    config.agent.memory.backend = 'filesystem';
    config.agent.memory.pgsql.enabled = false;

    const tools = createMemoryTools(workspacePath, config);
    const teamTool = tools.find((tool) => tool.name === 'memory_save_team');
    assert.ok(teamTool, 'memory_save_team should be registered');

    await withChannelConversationContext(
        {
            channel: 'dingtalk',
            conversationId: 'cid-team-room',
            isDirect: false,
            senderId: 'user-a',
            senderName: 'User A',
            pendingReplyFiles: [],
        },
        async () => {
            await teamTool!.invoke({
                target: 'long-term',
                reason: '标准流程',
                title: '查询历史数据前先确认日期',
                summary: '统一规范：查历史数据前先确认日期。',
                applicability: '所有含今天/昨天/上次等时间语义的数据查询',
                steps: ['先确认当前系统日期', '再确认用户目标日期', '最后执行查询'],
                constraints: ['不要直接猜测“今天”对应哪一天'],
                evidence: ['来自群聊多次纠偏记录'],
                tags: ['查询流程', '时间语义'],
            });
        },
    );

    const mainMemory = await readFile(join(workspacePath, 'memory', 'scopes', 'main', 'MEMORY.md'), 'utf-8');
    assert.match(mainMemory, /## 团队记忆条目/);
    assert.match(mainMemory, /- 标题: 查询历史数据前先确认日期/);
    assert.match(mainMemory, /统一规范：查历史数据前先确认日期/);
    assert.match(mainMemory, /### 操作步骤/);
    assert.match(mainMemory, /- 来源scopes: group_cid-team-room|- 来源scopes: group_cid_team_room/);
});

test('memory_save_team merges entries with the same title instead of appending duplicates', async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'srebot-memory-merge-'));
    t.after(async () => {
        await rm(workspacePath, { recursive: true, force: true });
    });

    const config = structuredClone(DEFAULT_CONFIG);
    config.agent.memory.backend = 'filesystem';
    config.agent.memory.pgsql.enabled = false;

    const tools = createMemoryTools(workspacePath, config);
    const teamTool = tools.find((tool) => tool.name === 'memory_save_team');
    assert.ok(teamTool);

    await withChannelConversationContext(
        {
            channel: 'dingtalk',
            conversationId: 'cid-team-room',
            isDirect: false,
            senderId: 'user-a',
            senderName: 'User A',
            pendingReplyFiles: [],
        },
        async () => {
            await teamTool!.invoke({
                target: 'long-term',
                reason: '标准流程',
                title: '查询历史数据前先确认日期',
                summary: '第一次沉淀：先确认当前日期。',
                steps: ['确认当前系统日期'],
                tags: ['时间语义'],
            });

            await teamTool!.invoke({
                target: 'long-term',
                reason: '团队共识',
                title: '查询历史数据前先确认日期',
                summary: '第二次补充：再确认用户目标日期。',
                steps: ['确认用户目标日期'],
                constraints: ['不要主观猜测“今天”指哪一天'],
                tags: ['查询流程'],
            });
        },
    );

    const mainMemory = await readFile(join(workspacePath, 'memory', 'scopes', 'main', 'MEMORY.md'), 'utf-8');
    const occurrences = (mainMemory.match(/## 团队记忆条目/g) || []).length;
    assert.equal(occurrences, 1);
    assert.match(mainMemory, /第一次沉淀：先确认当前日期。[\s\S]*补充：第二次补充：再确认用户目标日期。/);
    assert.match(mainMemory, /1\. 确认当前系统日期[\s\S]*2\. 确认用户目标日期/);
    assert.match(mainMemory, /- 晋升原因: 标准流程 \/ 团队共识|- 晋升原因: 团队共识 \/ 标准流程/);
    assert.match(mainMemory, /- 标签: 时间语义 \/ 查询流程|- 标签: 查询流程 \/ 时间语义/);
});

test('memory_save_team accepts multiline string fields for list sections', async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'srebot-memory-multiline-'));
    t.after(async () => {
        await rm(workspacePath, { recursive: true, force: true });
    });

    const config = structuredClone(DEFAULT_CONFIG);
    config.agent.memory.backend = 'filesystem';
    config.agent.memory.pgsql.enabled = false;

    const tools = createMemoryTools(workspacePath, config);
    const teamTool = tools.find((tool) => tool.name === 'memory_save_team');
    assert.ok(teamTool);

    await withChannelConversationContext(
        {
            channel: 'dingtalk',
            conversationId: 'cid-team-room',
            isDirect: false,
            senderId: 'user-a',
            senderName: 'User A',
            pendingReplyFiles: [],
        },
        async () => {
            await teamTool!.invoke({
                target: 'long-term',
                reason: '标准流程',
                title: '时间范围查询前必须确认系统日期',
                summary: '先确认系统日期，再计算查询窗口。',
                steps: '1. 执行 date 命令确认当前系统日期和时间\n2. 根据确认后的日期计算查询时间范围',
                constraints: '- 不要假设或硬编码日期\n- 在回复中明确标注查询的时间范围',
                evidence: '- 2026-03-04 用户明确要求并保存到长期记忆\n- 2026-03-10 用户再次纠正日期',
                tags: '- 标准流程\n- 时间校验',
            });
        },
    );

    const mainMemory = await readFile(join(workspacePath, 'memory', 'scopes', 'main', 'MEMORY.md'), 'utf-8');
    assert.match(mainMemory, /1\. 执行 date 命令确认当前系统日期和时间/);
    assert.match(mainMemory, /2\. 根据确认后的日期计算查询时间范围/);
    assert.match(mainMemory, /- 不要假设或硬编码日期/);
    assert.match(mainMemory, /- 2026-03-10 用户再次纠正日期/);
    assert.match(mainMemory, /- 标签: 标准流程 \/ 时间校验|- 标签: 时间校验 \/ 标准流程/);
});
