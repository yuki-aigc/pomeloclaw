import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkillFromSource, listInstalledSkills, removeInstalledSkill } from './manager.js';

async function createTempDir(prefix: string): Promise<string> {
    return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeSkill(dir: string, params?: { name?: string; description?: string; extraFile?: string }): Promise<void> {
    const skillName = params?.name || 'demo-skill';
    const description = params?.description || 'demo description';
    await mkdir(dir, { recursive: true });
    await writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: ${description}\n---\n\n# Demo\n`,
        'utf-8',
    );
    if (params?.extraFile) {
        await mkdir(path.join(dir, 'scripts'), { recursive: true });
        await writeFile(path.join(dir, 'scripts', params.extraFile), 'echo demo\n', 'utf-8');
    }
}

test('listInstalledSkills returns installed skill metadata', async () => {
    const skillsDir = await createTempDir('pomelobot-skills-list-');
    try {
        await writeSkill(path.join(skillsDir, 'demo-skill'));

        const skills = await listInstalledSkills(skillsDir);
        assert.equal(skills.length, 1);
        assert.equal(skills[0]?.name, 'demo-skill');
        assert.equal(skills[0]?.description, 'demo description');
    } finally {
        await rm(skillsDir, { recursive: true, force: true });
    }
});

test('installSkillFromSource installs from a local skill directory', async () => {
    const tempRoot = await createTempDir('pomelobot-skill-dir-src-');
    const skillsDir = await createTempDir('pomelobot-skill-dir-dest-');
    try {
        const sourceDir = path.join(tempRoot, 'remote-source');
        await writeSkill(sourceDir, { name: 'dir-installed-skill', description: 'installed from directory', extraFile: 'run.sh' });

        const result = await installSkillFromSource({
            source: sourceDir,
            skillsDir,
        });

        assert.equal(result.name, 'dir-installed-skill');
        assert.equal(result.dirName, 'remote-source');
        assert.equal(result.overwritten, false);
        const installedContent = await readFile(path.join(skillsDir, 'remote-source', 'scripts', 'run.sh'), 'utf-8');
        assert.equal(installedContent, 'echo demo\n');
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
        await rm(skillsDir, { recursive: true, force: true });
    }
});

test('installSkillFromSource installs from a local .skill archive and overwrites existing skill', async () => {
    const tempRoot = await createTempDir('pomelobot-skill-archive-src-');
    const skillsDir = await createTempDir('pomelobot-skill-archive-dest-');
    try {
        const archiveSkillDir = path.join(tempRoot, 'packed-skill');
        await writeSkill(archiveSkillDir, { name: 'archive-skill', description: 'installed from archive', extraFile: 'tool.py' });

        const zip = new AdmZip();
        zip.addLocalFolder(archiveSkillDir, 'packed-skill');
        const archivePath = path.join(tempRoot, 'archive-skill.skill');
        zip.writeZip(archivePath);

        await writeSkill(path.join(skillsDir, 'archive-skill'), { name: 'archive-skill', description: 'old version' });

        const result = await installSkillFromSource({
            source: archivePath,
            skillsDir,
        });

        assert.equal(result.name, 'archive-skill');
        assert.equal(result.overwritten, true);
        const installedContent = await readFile(path.join(skillsDir, 'archive-skill', 'scripts', 'tool.py'), 'utf-8');
        assert.equal(installedContent, 'echo demo\n');
        const skillMd = await readFile(path.join(skillsDir, 'archive-skill', 'SKILL.md'), 'utf-8');
        assert.match(skillMd, /installed from archive/);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
        await rm(skillsDir, { recursive: true, force: true });
    }
});

test('installSkillFromSource prefers source path basename when choosing overwrite target', async () => {
    const tempRoot = await createTempDir('pomelobot-skill-dir-hint-src-');
    const skillsDir = await createTempDir('pomelobot-skill-dir-hint-dest-');
    try {
        await writeSkill(path.join(skillsDir, 'same-path-name'), {
            name: 'old-frontmatter-name',
            description: 'old version',
        });

        const sourceDir = path.join(tempRoot, 'same-path-name');
        await writeSkill(sourceDir, {
            name: 'new-frontmatter-name',
            description: 'new version',
            extraFile: 'install.sh',
        });

        const result = await installSkillFromSource({
            source: sourceDir,
            skillsDir,
        });

        assert.equal(result.dirName, 'same-path-name');
        assert.equal(result.overwritten, true);
        assert.equal(existsSync(path.join(skillsDir, 'new-frontmatter-name')), false);
        assert.equal(existsSync(path.join(skillsDir, 'same-path-name', 'scripts', 'install.sh')), true);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
        await rm(skillsDir, { recursive: true, force: true });
    }
});

test('removeInstalledSkill removes by skill name or directory name', async () => {
    const skillsDir = await createTempDir('pomelobot-skill-remove-');
    try {
        await writeSkill(path.join(skillsDir, 'custom-folder'), {
            name: 'actual-skill-name',
            description: 'to be removed',
        });

        const result = await removeInstalledSkill({
            skillsDir,
            skillName: 'custom-folder',
        });

        assert.equal(result.name, 'actual-skill-name');
        assert.equal(existsSync(path.join(skillsDir, 'custom-folder')), false);
    } finally {
        await rm(skillsDir, { recursive: true, force: true });
    }
});
