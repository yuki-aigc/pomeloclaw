import AdmZip from 'adm-zip';
import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, readFile, rm, mkdir, rename, stat, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvWithCredentialFallback } from '../security/credential-env.js';

const SKILL_MD = 'SKILL.md';
const GITHUB_API_BASE = 'https://api.github.com';

export interface InstalledSkillSummary {
    name: string;
    description: string;
    dirName: string;
    absPath: string;
    updatedAtMs: number;
}

export interface SkillInstallResult {
    name: string;
    description: string;
    dirName: string;
    absPath: string;
    sourceLabel: string;
    sourceKind: 'github' | 'archive' | 'directory';
    installedFiles: number;
    overwritten: boolean;
}

export interface SkillRemoveResult {
    name: string;
    dirName: string;
    absPath: string;
    removed: boolean;
}

interface SkillMetadata {
    name: string;
    description: string;
}

type GitHubInstallSource = {
    kind: 'github';
    owner: string;
    repo: string;
    ref?: string;
    path?: string;
    sourceLabel: string;
    targetDirHint?: string;
};

type ArchiveInstallSource = {
    kind: 'archive';
    archivePath?: string;
    archiveUrl?: string;
    sourceLabel: string;
    targetDirHint?: string;
};

type DirectoryInstallSource = {
    kind: 'directory';
    directoryPath: string;
    sourceLabel: string;
    targetDirHint?: string;
};

type InstallSource = GitHubInstallSource | ArchiveInstallSource | DirectoryInstallSource;

type GitHubRepoInfo = {
    default_branch?: string;
};

type GitHubBranchInfo = {
    commit?: {
        commit?: {
            tree?: {
                sha?: string;
            };
        };
    };
};

type GitHubTreeEntry = {
    path?: string;
    type?: string;
};

type GitHubTreeResponse = {
    tree?: GitHubTreeEntry[];
    truncated?: boolean;
};

type GitHubContentResponse = {
    type?: string;
    encoding?: string;
    content?: string;
    download_url?: string | null;
};

function isSafeRelativePath(input: string): boolean {
    if (!input) return false;
    if (path.isAbsolute(input)) return false;
    const normalized = input.replace(/\\/g, '/');
    return !normalized.split('/').some((segment) => segment === '..' || segment === '');
}

function normalizeRelativePath(input: string): string {
    return input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function sanitizeSkillName(input: string): string {
    const normalized = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
    return normalized || 'imported-skill';
}

function extractFrontmatter(content: string): string | null {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    return match ? match[1] : null;
}

function extractFrontmatterValue(frontmatter: string, key: string): string | null {
    const pattern = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const match = frontmatter.match(pattern);
    if (!match) return null;
    const raw = match[1].trim();
    if (!raw) return null;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\''))) {
        return raw.slice(1, -1).trim() || null;
    }
    return raw;
}

async function readSkillMetadata(skillMdPath: string): Promise<SkillMetadata> {
    const content = await readFile(skillMdPath, 'utf-8');
    const frontmatter = extractFrontmatter(content);
    if (!frontmatter) {
        throw new Error(`${skillMdPath} 缺少 YAML frontmatter`);
    }
    const rawName = extractFrontmatterValue(frontmatter, 'name');
    const rawDescription = extractFrontmatterValue(frontmatter, 'description');
    if (!rawName || !rawDescription) {
        throw new Error(`${skillMdPath} 缺少必填 frontmatter 字段 name/description`);
    }
    return {
        name: sanitizeSkillName(rawName),
        description: rawDescription,
    };
}

async function countFiles(rootDir: string): Promise<number> {
    let total = 0;
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const absPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            total += await countFiles(absPath);
            continue;
        }
        if (entry.isFile()) {
            total += 1;
        }
    }
    return total;
}

async function collectSkillRoots(rootDir: string): Promise<string[]> {
    const results: string[] = [];
    async function walk(currentDir: string): Promise<void> {
        const entries = await readdir(currentDir, { withFileTypes: true });
        let hasSkillMd = false;
        for (const entry of entries) {
            if (entry.isFile() && entry.name === SKILL_MD) {
                hasSkillMd = true;
                break;
            }
        }
        if (hasSkillMd) {
            results.push(currentDir);
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            await walk(path.join(currentDir, entry.name));
        }
    }
    if (existsSync(rootDir)) {
        await walk(rootDir);
    }
    return results.sort();
}

async function ensureDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
}

function getGitHubAuthHeaders(): Record<string, string> {
    const token = readEnvWithCredentialFallback('GITHUB_TOKEN')?.trim();
    if (!token) {
        return {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'pomelobot-skill-installer',
        };
    }
    return {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'pomelobot-skill-installer',
    };
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`请求失败: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 200)}` : ''}`);
    }
    return await response.json() as T;
}

async function fetchBinary(url: string, headers?: Record<string, string>): Promise<Buffer> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`下载失败: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 200)}` : ''}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

function encodeGitHubPath(filePath: string): string {
    return normalizeRelativePath(filePath)
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

async function downloadGitHubFile(params: {
    owner: string;
    repo: string;
    ref: string;
    filePath: string;
    headers: Record<string, string>;
}): Promise<Buffer> {
    const encodedPath = encodeGitHubPath(params.filePath);
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(params.ref)}`;
    const payload = await fetchJson<GitHubContentResponse>(url, params.headers);
    if (payload.encoding === 'base64' && typeof payload.content === 'string') {
        return Buffer.from(payload.content.replace(/\n/g, ''), 'base64');
    }
    if (payload.download_url) {
        return await fetchBinary(payload.download_url, params.headers);
    }
    throw new Error(`GitHub 文件下载失败: ${params.filePath}`);
}

async function materializeGitHubSkill(source: GitHubInstallSource, tempRoot: string): Promise<{ skillRoot: string; sourceLabel: string; targetDirHint?: string }> {
    const headers = getGitHubAuthHeaders();
    const repoInfoUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
    const repoInfo = await fetchJson<GitHubRepoInfo>(repoInfoUrl, headers);
    const ref = source.ref || repoInfo.default_branch;
    if (!ref) {
        throw new Error(`无法解析 GitHub 仓库默认分支: ${source.owner}/${source.repo}`);
    }

    const branchUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/branches/${encodeURIComponent(ref)}`;
    const branch = await fetchJson<GitHubBranchInfo>(branchUrl, headers);
    const treeSha = branch.commit?.commit?.tree?.sha;
    if (!treeSha) {
        throw new Error(`无法读取 GitHub 分支树: ${source.owner}/${source.repo}@${ref}`);
    }

    const treeUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`;
    const tree = await fetchJson<GitHubTreeResponse>(treeUrl, headers);
    if (tree.truncated) {
        throw new Error(`GitHub 仓库文件树过大，无法安全导入: ${source.owner}/${source.repo}`);
    }

    const skillCandidates = (tree.tree || [])
        .filter((item) => item.type === 'blob' && typeof item.path === 'string' && item.path.endsWith(`/${SKILL_MD}`))
        .map((item) => path.posix.dirname(item.path as string))
        .concat(
            (tree.tree || [])
                .filter((item) => item.type === 'blob' && item.path === SKILL_MD)
                .map(() => '')
        );

    let skillRoot = '';
    if (source.path) {
        const requested = normalizeRelativePath(source.path.replace(/\/SKILL\.md$/i, ''));
        if (!skillCandidates.includes(requested)) {
            throw new Error(`GitHub 路径下未找到 ${SKILL_MD}: ${source.owner}/${source.repo}/${requested}`);
        }
        skillRoot = requested;
    } else if (skillCandidates.length === 1) {
        skillRoot = skillCandidates[0] || '';
    } else if (skillCandidates.length === 0) {
        throw new Error(`仓库中未找到任何 ${SKILL_MD}: ${source.owner}/${source.repo}`);
    } else {
        const candidates = skillCandidates.map((item) => item || '(repo root)').join(', ');
        throw new Error(`仓库中发现多个技能目录，请显式指定路径: ${candidates}`);
    }

    const files = (tree.tree || [])
        .filter((item) => item.type === 'blob' && typeof item.path === 'string')
        .map((item) => item.path as string)
        .filter((filePath) => {
            if (!skillRoot) return true;
            return filePath === `${skillRoot}/${SKILL_MD}` || filePath.startsWith(`${skillRoot}/`);
        });

    if (files.length === 0) {
        throw new Error(`技能目录为空: ${source.owner}/${source.repo}${skillRoot ? `/${skillRoot}` : ''}`);
    }

    const extractRoot = path.join(tempRoot, 'github');
    await ensureDir(extractRoot);

    for (const remotePath of files) {
        const relativePath = skillRoot
            ? normalizeRelativePath(remotePath.slice(skillRoot.length).replace(/^\/+/, ''))
            : normalizeRelativePath(remotePath);
        if (!relativePath || !isSafeRelativePath(relativePath)) {
            throw new Error(`检测到不安全的技能文件路径: ${remotePath}`);
        }
        const fileBuffer = await downloadGitHubFile({
            owner: source.owner,
            repo: source.repo,
            ref,
            filePath: remotePath,
            headers,
        });
        const targetPath = path.join(extractRoot, relativePath);
        await ensureDir(path.dirname(targetPath));
        await writeFile(targetPath, fileBuffer);
    }

    return {
        skillRoot: extractRoot,
        sourceLabel: `${source.owner}/${source.repo}${skillRoot ? `/${skillRoot}` : ''}@${ref}`,
        targetDirHint: source.targetDirHint || sanitizeSkillName(skillRoot ? path.posix.basename(skillRoot) : source.repo),
    };
}

function assertSafeArchiveEntry(entryName: string): string {
    const normalized = entryName.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized) {
        throw new Error('压缩包包含空路径条目');
    }
    if (!isSafeRelativePath(normalized)) {
        throw new Error(`压缩包包含不安全路径: ${entryName}`);
    }
    return normalized;
}

async function extractZipBufferToDir(buffer: Buffer, targetDir: string): Promise<void> {
    const archive = new AdmZip(buffer);
    const entries = archive.getEntries();
    for (const entry of entries) {
        const relativePath = assertSafeArchiveEntry(entry.entryName);
        const absPath = path.join(targetDir, relativePath);
        if (entry.isDirectory) {
            await ensureDir(absPath);
            continue;
        }
        await ensureDir(path.dirname(absPath));
        await writeFile(absPath, entry.getData());
    }
}

async function materializeArchiveSkill(source: ArchiveInstallSource, tempRoot: string): Promise<{ skillRoot: string; sourceLabel: string; targetDirHint?: string }> {
    const buffer = source.archiveUrl
        ? await fetchBinary(source.archiveUrl)
        : await readFile(source.archivePath as string);
    const extractRoot = path.join(tempRoot, 'archive');
    await ensureDir(extractRoot);
    await extractZipBufferToDir(buffer, extractRoot);

    const candidates = await collectSkillRoots(extractRoot);
    if (candidates.length === 0) {
        throw new Error(`压缩包中未找到任何 ${SKILL_MD}`);
    }
    if (candidates.length > 1) {
        const labels = candidates.map((item) => path.relative(extractRoot, item) || '.').join(', ');
        throw new Error(`压缩包中包含多个技能目录，请保持一个压缩包只包含一个技能: ${labels}`);
    }

    return {
        skillRoot: candidates[0],
        sourceLabel: source.sourceLabel,
        targetDirHint: source.targetDirHint || sanitizeSkillName(path.basename(candidates[0])),
    };
}

async function materializeDirectorySkill(source: DirectoryInstallSource): Promise<{ skillRoot: string; sourceLabel: string; targetDirHint?: string }> {
    const sourcePath = path.resolve(source.directoryPath);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isDirectory()) {
        throw new Error(`不是有效目录: ${source.directoryPath}`);
    }

    const directSkillMdPath = path.join(sourcePath, SKILL_MD);
    if (existsSync(directSkillMdPath)) {
        return {
            skillRoot: sourcePath,
            sourceLabel: source.sourceLabel,
            targetDirHint: source.targetDirHint || sanitizeSkillName(path.basename(sourcePath)),
        };
    }

    const candidates = await collectSkillRoots(sourcePath);
    if (candidates.length === 0) {
        throw new Error(`目录中未找到任何 ${SKILL_MD}: ${source.directoryPath}`);
    }
    if (candidates.length > 1) {
        const labels = candidates.map((item) => path.relative(sourcePath, item) || '.').join(', ');
        throw new Error(`目录下存在多个技能目录，请显式指定技能子目录: ${labels}`);
    }

    return {
        skillRoot: candidates[0],
        sourceLabel: source.sourceLabel,
        targetDirHint: source.targetDirHint || sanitizeSkillName(path.basename(candidates[0])),
    };
}

function parseGitHubUrl(input: string): GitHubInstallSource | null {
    const url = new URL(input);
    if (url.hostname !== 'github.com') {
        return null;
    }
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (segments.length < 2) {
        return null;
    }
    const [owner, repo, maybeTree, maybeRef, ...rest] = segments;
    if (maybeTree === 'tree') {
        return {
            kind: 'github',
            owner,
            repo,
            ref: maybeRef,
            path: rest.join('/'),
            sourceLabel: input,
            targetDirHint: rest.length > 0 ? sanitizeSkillName(rest[rest.length - 1] || '') : sanitizeSkillName(repo),
        };
    }
    return {
        kind: 'github',
        owner,
        repo,
        sourceLabel: input,
        targetDirHint: sanitizeSkillName(repo),
    };
}

function parseGitHubShorthand(input: string): GitHubInstallSource | null {
    if (input.includes('://')) return null;
    const normalized = input.replace(/^github:/i, '').trim();
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const [owner, repo, ...rest] = segments;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
        return null;
    }
    return {
        kind: 'github',
        owner,
        repo,
        path: rest.length > 0 ? rest.join('/') : undefined,
        sourceLabel: input,
        targetDirHint: sanitizeSkillName((rest.length > 0 ? rest[rest.length - 1] : repo) || repo),
    };
}

async function resolveInstallSource(input: string): Promise<InstallSource> {
    const source = input.trim();
    if (!source) {
        throw new Error('技能来源不能为空');
    }

    const localPath = path.resolve(source);
    if (existsSync(localPath)) {
        const sourceStat = await stat(localPath);
        if (sourceStat.isDirectory()) {
            return {
                kind: 'directory',
                directoryPath: localPath,
                sourceLabel: source,
                targetDirHint: sanitizeSkillName(path.basename(localPath)),
            };
        }
        if (sourceStat.isFile() && /\.(skill|zip)$/i.test(localPath)) {
            return {
                kind: 'archive',
                archivePath: localPath,
                sourceLabel: source,
                targetDirHint: sanitizeSkillName(path.basename(localPath).replace(/\.(skill|zip)$/i, '')),
            };
        }
        throw new Error(`暂不支持安装该本地文件类型: ${source}`);
    }

    if (/^https?:\/\//i.test(source)) {
        const github = parseGitHubUrl(source);
        if (github) return github;
        if (/\.(skill|zip)(?:\?.*)?$/i.test(source)) {
            const url = new URL(source);
            const fileName = path.posix.basename(url.pathname).replace(/\.(skill|zip)$/i, '');
            return {
                kind: 'archive',
                archiveUrl: source,
                sourceLabel: source,
                targetDirHint: sanitizeSkillName(fileName),
            };
        }
        throw new Error('当前仅支持 GitHub 仓库 URL，或直链 .skill/.zip 压缩包');
    }

    const github = parseGitHubShorthand(source);
    if (github) return github;

    throw new Error('无法识别技能来源。支持格式: owner/repo[/path]、GitHub URL、.skill/.zip 路径或 URL');
}

async function installPreparedSkill(params: {
    preparedSkillRoot: string;
    sourceLabel: string;
    sourceKind: SkillInstallResult['sourceKind'];
    skillsDir: string;
    targetDirHint?: string;
}): Promise<SkillInstallResult> {
    const skillMdPath = path.join(params.preparedSkillRoot, SKILL_MD);
    if (!existsSync(skillMdPath)) {
        throw new Error(`技能目录缺少 ${SKILL_MD}`);
    }

    const metadata = await readSkillMetadata(skillMdPath);
    const targetDirName = sanitizeSkillName(params.targetDirHint || metadata.name || path.basename(params.preparedSkillRoot));
    const skillsDir = path.resolve(params.skillsDir);
    const targetDir = path.join(skillsDir, targetDirName);
    const stagingParent = await mkdtemp(path.join(os.tmpdir(), 'pomelobot-skill-stage-'));
    const stagedDir = path.join(stagingParent, targetDirName);

    await ensureDir(skillsDir);
    await cp(params.preparedSkillRoot, stagedDir, { recursive: true, force: true });

    const existed = existsSync(targetDir);
    if (existed) {
        await rm(targetDir, { recursive: true, force: true });
    }
    await rename(stagedDir, targetDir);

    const installedFiles = await countFiles(targetDir);
    await rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);

    return {
        name: metadata.name,
        description: metadata.description,
        dirName: targetDirName,
        absPath: targetDir,
        sourceLabel: params.sourceLabel,
        sourceKind: params.sourceKind,
        installedFiles,
        overwritten: existed,
    };
}

export async function listInstalledSkills(skillsDir: string): Promise<InstalledSkillSummary[]> {
    const resolvedDir = path.resolve(skillsDir);
    if (!existsSync(resolvedDir)) {
        return [];
    }

    const entries = await readdir(resolvedDir, { withFileTypes: true });
    const skills: InstalledSkillSummary[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(resolvedDir, entry.name);
        const skillMdPath = path.join(skillDir, SKILL_MD);
        if (!existsSync(skillMdPath)) continue;
        try {
            const metadata = await readSkillMetadata(skillMdPath);
            const fileStat = await stat(skillMdPath);
            skills.push({
                name: metadata.name,
                description: metadata.description,
                dirName: entry.name,
                absPath: skillDir,
                updatedAtMs: fileStat.mtimeMs,
            });
        } catch {
            continue;
        }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function installSkillFromSource(params: {
    source: string;
    skillsDir: string;
}): Promise<SkillInstallResult> {
    const installSource = await resolveInstallSource(params.source);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pomelobot-skill-import-'));

    try {
        if (installSource.kind === 'github') {
            const prepared = await materializeGitHubSkill(installSource, tempRoot);
            return await installPreparedSkill({
                preparedSkillRoot: prepared.skillRoot,
                sourceLabel: prepared.sourceLabel,
                sourceKind: 'github',
                skillsDir: params.skillsDir,
                targetDirHint: prepared.targetDirHint,
            });
        }

        if (installSource.kind === 'archive') {
            const prepared = await materializeArchiveSkill(installSource, tempRoot);
            return await installPreparedSkill({
                preparedSkillRoot: prepared.skillRoot,
                sourceLabel: prepared.sourceLabel,
                sourceKind: 'archive',
                skillsDir: params.skillsDir,
                targetDirHint: prepared.targetDirHint,
            });
        }

        const prepared = await materializeDirectorySkill(installSource);
        return await installPreparedSkill({
            preparedSkillRoot: prepared.skillRoot,
            sourceLabel: prepared.sourceLabel,
            sourceKind: 'directory',
            skillsDir: params.skillsDir,
            targetDirHint: prepared.targetDirHint,
        });
    } finally {
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

export async function removeInstalledSkill(params: {
    skillsDir: string;
    skillName: string;
}): Promise<SkillRemoveResult> {
    const normalizedTarget = sanitizeSkillName(params.skillName);
    if (!normalizedTarget) {
        throw new Error('技能名称不能为空');
    }

    const skills = await listInstalledSkills(params.skillsDir);
    const matched = skills.find((skill) =>
        skill.name === normalizedTarget || sanitizeSkillName(skill.dirName) === normalizedTarget
    );
    if (!matched) {
        throw new Error(`未找到技能: ${params.skillName}`);
    }

    await rm(matched.absPath, { recursive: true, force: true });
    return {
        name: matched.name,
        dirName: matched.dirName,
        absPath: matched.absPath,
        removed: true,
    };
}

export function formatInstalledSkills(skills: InstalledSkillSummary[]): string {
    if (skills.length === 0) {
        return '当前没有已安装技能。';
    }
    const lines = ['## 已安装技能', ''];
    for (const skill of skills) {
        lines.push(`- \`${skill.name}\` -> ${skill.description}`);
    }
    return lines.join('\n');
}

export function formatSkillInstallResult(result: SkillInstallResult): string {
    const overwriteText = result.overwritten ? '覆盖更新' : '新安装';
    return [
        `✅ 技能已安装：\`${result.name}\``,
        '',
        `- 状态：${overwriteText}`,
        `- 来源：${result.sourceLabel}`,
        `- 目录：\`${result.dirName}\``,
        `- 文件数：${result.installedFiles}`,
        `- 描述：${result.description}`,
    ].join('\n');
}

export function formatSkillRemoveResult(result: SkillRemoveResult): string {
    return [
        `✅ 技能已删除：\`${result.name}\``,
        '',
        `- 目录：\`${result.dirName}\``,
        `- 路径：\`${result.absPath}\``,
    ].join('\n');
}
