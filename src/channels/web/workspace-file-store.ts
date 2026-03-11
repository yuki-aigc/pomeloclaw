import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { isPathInsideDir } from './file-utils.js';

const SKILL_MARKDOWN_FILE = 'SKILL.md';
const DEFAULT_SKILL_REL_PATH = SKILL_MARKDOWN_FILE;
const DEFAULT_MEMORY_REL_PATH = 'MEMORY.md';
const SKILL_DIR_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MEMORY_REL_PATH_RE = /^(MEMORY\.md|memory(?:\/[A-Za-z0-9._-]+)+\.md)$/u;
const MAX_SKILL_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_TREE_ENTRIES = 3000;

export interface WebManagedFileMeta {
    exists: boolean;
    absPath: string;
    sizeBytes?: number;
    updatedAtMs?: number;
}

export interface WebSkillFileSummary extends WebManagedFileMeta {
    skillDir: string;
}

export interface WebManagedFileReadResult extends WebManagedFileMeta {
    content?: string;
}

export interface WebSkillFileTreeNode {
    path: string;
    name: string;
    kind: 'file' | 'directory';
    sizeBytes?: number;
    updatedAtMs?: number;
    children?: WebSkillFileTreeNode[];
}

export interface WebSkillFileTreeResult {
    exists: boolean;
    skillDir: string;
    skillRootPath: string;
    tree: WebSkillFileTreeNode[];
    fileCount: number;
    directoryCount: number;
}

function isNotFoundError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

async function resolveRootPath(rootPath: string): Promise<string> {
    const resolved = path.resolve(rootPath);
    try {
        return await fsPromises.realpath(resolved);
    } catch (error) {
        if (isNotFoundError(error)) {
            return resolved;
        }
        throw error;
    }
}

function normalizeSafeRelativePath(rawPath: string): string {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) {
        throw new Error('路径不能为空');
    }
    if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
        throw new Error('路径非法：不允许使用 . 或 ..');
    }
    return normalized;
}

function normalizeSkillDirName(skillDir: string): string {
    const normalized = skillDir.trim();
    if (!normalized) {
        throw new Error('skill 不能为空');
    }
    if (!SKILL_DIR_NAME_RE.test(normalized)) {
        throw new Error('skill 非法：仅允许字母、数字、点、下划线、中划线');
    }
    return normalized;
}

function normalizeSkillFileRelPath(rawPath?: string): string {
    const candidate = rawPath?.trim() || DEFAULT_SKILL_REL_PATH;
    return normalizeSafeRelativePath(candidate);
}

function normalizeMemoryRelPath(rawPath?: string): string {
    const candidate = rawPath?.trim() || DEFAULT_MEMORY_REL_PATH;
    const normalized = normalizeSafeRelativePath(candidate);
    if (!MEMORY_REL_PATH_RE.test(normalized)) {
        throw new Error('memory 路径非法：仅允许 MEMORY.md 或 memory/**/*.md');
    }
    return normalized;
}

async function statRegularFile(
    absPath: string,
    rootReal?: string,
): Promise<{ sizeBytes: number; updatedAtMs: number } | null> {
    let lstat;
    try {
        lstat = await fsPromises.lstat(absPath);
    } catch (error) {
        if (isNotFoundError(error)) {
            return null;
        }
        throw error;
    }

    if (lstat.isSymbolicLink()) {
        throw new Error('路径非法：不允许符号链接文件');
    }
    if (!lstat.isFile()) {
        throw new Error('路径非法：目标不是普通文件');
    }
    if (lstat.nlink > 1) {
        throw new Error('路径非法：不允许硬链接文件');
    }

    const realPath = await fsPromises.realpath(absPath).catch(() => absPath);
    if (rootReal && !isPathInsideDir(realPath, rootReal)) {
        throw new Error('路径非法：目标超出根目录');
    }
    const stat = await fsPromises.stat(realPath);
    if (!stat.isFile()) {
        throw new Error('路径非法：目标不是普通文件');
    }
    if (stat.nlink > 1) {
        throw new Error('路径非法：不允许硬链接文件');
    }

    return {
        sizeBytes: stat.size,
        updatedAtMs: Math.floor(stat.mtimeMs),
    };
}

async function resolvePathWithinRoot(rootPath: string, relativePath: string): Promise<{ rootReal: string; absPath: string }> {
    const rootReal = await resolveRootPath(rootPath);
    const absPath = path.resolve(rootReal, relativePath);
    if (!isPathInsideDir(absPath, rootReal)) {
        throw new Error('路径非法：超出根目录');
    }
    return { rootReal, absPath };
}

async function resolveSkillRoot(params: {
    skillsRoot: string;
    skillDir: string;
}): Promise<{ skillDir: string; skillsRootReal: string; skillRootPath: string; exists: boolean }> {
    const skillDir = normalizeSkillDirName(params.skillDir);
    const { rootReal: skillsRootReal, absPath: skillRootPath } = await resolvePathWithinRoot(params.skillsRoot, skillDir);

    let lstat;
    try {
        lstat = await fsPromises.lstat(skillRootPath);
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                skillDir,
                skillsRootReal,
                skillRootPath,
                exists: false,
            };
        }
        throw error;
    }

    if (lstat.isSymbolicLink()) {
        throw new Error('路径非法：skill 目录不允许符号链接');
    }
    if (!lstat.isDirectory()) {
        throw new Error('路径非法：skill 不是目录');
    }

    const realPath = await fsPromises.realpath(skillRootPath).catch(() => skillRootPath);
    if (!isPathInsideDir(realPath, skillsRootReal)) {
        throw new Error('路径非法：skill 目录超出根目录');
    }

    return {
        skillDir,
        skillsRootReal,
        skillRootPath: realPath,
        exists: true,
    };
}

async function ensureSafeParentDir(rootReal: string, absFilePath: string): Promise<void> {
    const relativeDir = path.relative(rootReal, path.dirname(absFilePath)).replace(/\\/g, '/');
    if (!relativeDir || relativeDir === '.') {
        return;
    }

    const segments = relativeDir.split('/').filter(Boolean);
    let currentDir = rootReal;
    for (const segment of segments) {
        currentDir = path.join(currentDir, segment);
        let lstat;
        try {
            lstat = await fsPromises.lstat(currentDir);
        } catch (error) {
            if (!isNotFoundError(error)) {
                throw error;
            }
            await fsPromises.mkdir(currentDir);
            continue;
        }

        if (lstat.isSymbolicLink()) {
            throw new Error('路径非法：父目录包含符号链接');
        }
        if (!lstat.isDirectory()) {
            throw new Error('路径非法：父路径不是目录');
        }
        const realPath = await fsPromises.realpath(currentDir).catch(() => currentDir);
        if (!isPathInsideDir(realPath, rootReal)) {
            throw new Error('路径非法：父目录超出根目录');
        }
    }
}

async function atomicWriteUtf8(absPath: string, content: string): Promise<void> {
    const tempPath = path.join(path.dirname(absPath), `.${path.basename(absPath)}.${process.pid}.${randomUUID()}.tmp`);
    await fsPromises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
        await fsPromises.rename(tempPath, absPath);
    } finally {
        await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

async function readTextFileContent(absPath: string, maxBytes: number): Promise<string> {
    const buffer = await fsPromises.readFile(absPath);
    if (buffer.length > maxBytes) {
        throw new Error(`文件过大，超过 ${maxBytes} 字节限制`);
    }
    if (buffer.includes(0)) {
        throw new Error('暂不支持读取二进制文件');
    }
    return buffer.toString('utf8');
}

export async function listSkillMarkdownFiles(skillsRoot: string): Promise<WebSkillFileSummary[]> {
    const rootReal = await resolveRootPath(skillsRoot);
    let entries;
    try {
        entries = await fsPromises.readdir(rootReal, { withFileTypes: true });
    } catch (error) {
        if (isNotFoundError(error)) {
            return [];
        }
        throw error;
    }

    const results: WebSkillFileSummary[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        if (!SKILL_DIR_NAME_RE.test(entry.name)) {
            continue;
        }
        const absPath = path.join(rootReal, entry.name, SKILL_MARKDOWN_FILE);
        try {
            const meta = await statRegularFile(absPath, rootReal);
            if (!meta) {
                continue;
            }
            results.push({
                skillDir: entry.name,
                exists: true,
                absPath,
                sizeBytes: meta.sizeBytes,
                updatedAtMs: meta.updatedAtMs,
            });
        } catch {
            continue;
        }
    }

    return results.sort((a, b) => a.skillDir.localeCompare(b.skillDir));
}

export async function listSkillFiles(params: {
    skillsRoot: string;
    skillDir: string;
}): Promise<WebSkillFileTreeResult> {
    const skill = await resolveSkillRoot(params);
    if (!skill.exists) {
        return {
            exists: false,
            skillDir: skill.skillDir,
            skillRootPath: skill.skillRootPath,
            tree: [],
            fileCount: 0,
            directoryCount: 0,
        };
    }

    let nodeCount = 0;
    let fileCount = 0;
    let directoryCount = 0;

    const walk = async (dirPath: string, relDir: string): Promise<WebSkillFileTreeNode[]> => {
        const children = await fsPromises.readdir(dirPath, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        const nodes: WebSkillFileTreeNode[] = [];

        for (const child of children) {
            if (nodeCount >= MAX_SKILL_TREE_ENTRIES) {
                throw new Error(`skill 文件数过多，超过 ${MAX_SKILL_TREE_ENTRIES} 条目限制`);
            }

            const childRelPath = relDir ? `${relDir}/${child.name}` : child.name;
            const childAbsPath = path.join(dirPath, child.name);
            const childLstat = await fsPromises.lstat(childAbsPath);
            if (childLstat.isSymbolicLink()) {
                continue;
            }

            const realPath = await fsPromises.realpath(childAbsPath).catch(() => childAbsPath);
            if (!isPathInsideDir(realPath, skill.skillRootPath)) {
                continue;
            }

            if (childLstat.isDirectory()) {
                directoryCount += 1;
                nodeCount += 1;
                const childrenNodes = await walk(realPath, childRelPath);
                nodes.push({
                    path: childRelPath,
                    name: child.name,
                    kind: 'directory',
                    children: childrenNodes,
                });
                continue;
            }

            if (!childLstat.isFile()) {
                continue;
            }
            if (childLstat.nlink > 1) {
                continue;
            }

            fileCount += 1;
            nodeCount += 1;
            nodes.push({
                path: childRelPath,
                name: child.name,
                kind: 'file',
                sizeBytes: childLstat.size,
                updatedAtMs: Math.floor(childLstat.mtimeMs),
            });
        }

        return nodes;
    };

    const tree = await walk(skill.skillRootPath, '');

    return {
        exists: true,
        skillDir: skill.skillDir,
        skillRootPath: skill.skillRootPath,
        tree,
        fileCount,
        directoryCount,
    };
}

export async function readSkillFile(params: {
    skillsRoot: string;
    skillDir: string;
    relativePath?: string;
}): Promise<WebManagedFileReadResult & { skillDir: string; relativePath: string }> {
    const skillDir = normalizeSkillDirName(params.skillDir);
    const relativePath = normalizeSkillFileRelPath(params.relativePath);
    const targetPath = normalizeSafeRelativePath(`${skillDir}/${relativePath}`);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.skillsRoot, targetPath);
    const meta = await statRegularFile(absPath, rootReal);
    if (!meta) {
        return {
            exists: false,
            absPath,
            skillDir,
            relativePath,
        };
    }

    const content = await readTextFileContent(absPath, MAX_SKILL_TEXT_FILE_BYTES);
    return {
        exists: true,
        absPath,
        skillDir,
        relativePath,
        content,
        sizeBytes: meta.sizeBytes,
        updatedAtMs: meta.updatedAtMs,
    };
}

export async function writeSkillFile(params: {
    skillsRoot: string;
    skillDir: string;
    relativePath?: string;
    content: string;
}): Promise<WebManagedFileReadResult & { skillDir: string; relativePath: string }> {
    const skillDir = normalizeSkillDirName(params.skillDir);
    const relativePath = normalizeSkillFileRelPath(params.relativePath);
    const targetPath = normalizeSafeRelativePath(`${skillDir}/${relativePath}`);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.skillsRoot, targetPath);
    const bytes = Buffer.byteLength(params.content, 'utf8');
    if (bytes > MAX_SKILL_TEXT_FILE_BYTES) {
        throw new Error(`文件过大，超过 ${MAX_SKILL_TEXT_FILE_BYTES} 字节限制`);
    }

    await fsPromises.mkdir(rootReal, { recursive: true });
    await ensureSafeParentDir(rootReal, absPath);
    await atomicWriteUtf8(absPath, params.content);
    const meta = await statRegularFile(absPath, rootReal);
    return {
        exists: true,
        absPath,
        skillDir,
        relativePath,
        content: params.content,
        sizeBytes: meta?.sizeBytes,
        updatedAtMs: meta?.updatedAtMs,
    };
}

export async function readSkillMarkdownFile(params: {
    skillsRoot: string;
    skillDir: string;
}): Promise<WebManagedFileReadResult> {
    const result = await readSkillFile({
        skillsRoot: params.skillsRoot,
        skillDir: params.skillDir,
        relativePath: SKILL_MARKDOWN_FILE,
    });
    return {
        exists: result.exists,
        absPath: result.absPath,
        content: result.content,
        sizeBytes: result.sizeBytes,
        updatedAtMs: result.updatedAtMs,
    };
}

export async function writeSkillMarkdownFile(params: {
    skillsRoot: string;
    skillDir: string;
    content: string;
}): Promise<WebManagedFileReadResult> {
    const result = await writeSkillFile({
        skillsRoot: params.skillsRoot,
        skillDir: params.skillDir,
        relativePath: SKILL_MARKDOWN_FILE,
        content: params.content,
    });
    return {
        exists: result.exists,
        absPath: result.absPath,
        content: result.content,
        sizeBytes: result.sizeBytes,
        updatedAtMs: result.updatedAtMs,
    };
}

export async function readMemoryMarkdownFile(params: {
    workspaceRoot: string;
    relativePath?: string;
}): Promise<WebManagedFileReadResult & { relativePath: string }> {
    const relativePath = normalizeMemoryRelPath(params.relativePath);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.workspaceRoot, relativePath);
    const meta = await statRegularFile(absPath, rootReal);
    if (!meta) {
        return {
            exists: false,
            absPath,
            relativePath,
        };
    }
    const content = await fsPromises.readFile(absPath, 'utf8');
    return {
        exists: true,
        absPath,
        relativePath,
        content,
        sizeBytes: meta.sizeBytes,
        updatedAtMs: meta.updatedAtMs,
    };
}

export async function writeMemoryMarkdownFile(params: {
    workspaceRoot: string;
    relativePath?: string;
    content: string;
}): Promise<WebManagedFileReadResult & { relativePath: string }> {
    const relativePath = normalizeMemoryRelPath(params.relativePath);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.workspaceRoot, relativePath);
    await fsPromises.mkdir(rootReal, { recursive: true });
    await ensureSafeParentDir(rootReal, absPath);
    await atomicWriteUtf8(absPath, params.content);
    const meta = await statRegularFile(absPath, rootReal);
    return {
        exists: true,
        absPath,
        relativePath,
        content: params.content,
        sizeBytes: meta?.sizeBytes,
        updatedAtMs: meta?.updatedAtMs,
    };
}
