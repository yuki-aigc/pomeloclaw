import {
    extractReplyTextFromEventData,
    extractTextBlocks,
    sanitizeUserFacingText,
} from '../streaming.js';

export interface WebProcessCommentaryBlock {
    type: 'commentary';
    text: string;
}

export interface WebProcessToolBlock {
    type: 'tool';
    phase: 'start' | 'end';
    toolName: string;
    preview?: string;
}

export type WebProcessBlock = WebProcessCommentaryBlock | WebProcessToolBlock;

export interface WebProcessPayload {
    title: string;
    default_collapsed: boolean;
    summary: string;
    text: string;
    blocks: WebProcessBlock[];
}

function compactWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function appendProcessCommentaryBlock(
    blocks: WebProcessBlock[],
    delta: string,
): void {
    const trimmed = delta.trim();
    if (!trimmed) {
        return;
    }

    const last = blocks[blocks.length - 1];
    if (last?.type === 'commentary') {
        last.text = `${last.text}${delta}`;
        return;
    }

    blocks.push({
        type: 'commentary',
        text: delta,
    });
}

export function extractProcessPreview(value: unknown, maxLength: number = 180): string | undefined {
    const directText = sanitizeUserFacingText(extractTextBlocks(value));
    if (directText) {
        return truncateText(compactWhitespace(directText), maxLength);
    }

    const nestedText = sanitizeUserFacingText(extractReplyTextFromEventData(value));
    if (nestedText) {
        return truncateText(compactWhitespace(nestedText), maxLength);
    }

    if (value == null) {
        return undefined;
    }

    const raw = compactWhitespace(safeJsonStringify(value));
    if (!raw || raw === '{}' || raw === '[]') {
        return undefined;
    }
    return truncateText(raw, maxLength);
}

export function buildProcessText(blocks: WebProcessBlock[]): string {
    const lines: string[] = [];
    for (const block of blocks) {
        if (block.type === 'commentary') {
            const text = block.text.trim();
            if (text) {
                lines.push(text);
            }
            continue;
        }
        const prefix = block.phase === 'start' ? '开始调用工具' : '工具执行完成';
        const suffix = block.preview ? `：${block.preview}` : '';
        lines.push(`${prefix} ${block.toolName}${suffix}`);
    }
    return lines.join('\n\n').trim();
}

export function buildProcessSummary(blocks: WebProcessBlock[]): string {
    const commentaryCount = blocks.filter((block) => block.type === 'commentary').length;
    const toolBlocks = blocks.filter((block): block is WebProcessToolBlock => block.type === 'tool');
    const toolNames = Array.from(new Set(toolBlocks.map((block) => block.toolName))).filter(Boolean);

    if (toolNames.length > 0 && commentaryCount > 0) {
        return `已记录 ${commentaryCount} 段过程文本，涉及 ${toolNames.length} 个工具：${toolNames.join(', ')}`;
    }
    if (toolNames.length > 0) {
        return `涉及 ${toolNames.length} 个工具：${toolNames.join(', ')}`;
    }
    if (commentaryCount > 0) {
        return `已记录 ${commentaryCount} 段过程文本`;
    }
    return '执行过程中未产生可展示的过程信息';
}

export function buildProcessPayload(blocks: WebProcessBlock[]): WebProcessPayload | undefined {
    if (blocks.length === 0) {
        return undefined;
    }
    return {
        title: '执行过程',
        default_collapsed: true,
        summary: buildProcessSummary(blocks),
        text: buildProcessText(blocks),
        blocks,
    };
}
