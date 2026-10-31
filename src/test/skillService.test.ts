import * as assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillService } from '../host/services/SkillService';

const SKILL_MD = (name: string, description = `${name} skill`): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function writeSkillDir(root: string, dirName: string, frontmatterName = dirName): void {
	const dir = join(root, dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'SKILL.md'), SKILL_MD(frontmatterName), 'utf-8');
}

function writeSkillFile(root: string, fileName: string, frontmatterName: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, fileName), SKILL_MD(frontmatterName), 'utf-8');
}

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

suite('SkillService scanning', () => {
	let home: string;

	setup(() => {
		home = makeTempDir('skills-home-');
	});

	teardown(() => {
		rmSync(home, { recursive: true, force: true });
	});

	test('scans the v1 singular ~/.config/opencode/skill directory', async () => {
		writeSkillDir(join(home, '.config', 'opencode', 'skill'), 'winui-setup');

		const config = await SkillService.getAllSkills(null, { homeDir: home });

		const skill = config.global['global-winui-setup'];
		assert.ok(skill, 'v1 singular directory must be scanned');
		assert.strictEqual(skill.skillId, 'winui-setup');
		assert.strictEqual(skill.name, 'winui-setup');
		assert.strictEqual(skill.enabled, true);
	});

	test('scans the v2 plural directories and .claude/.agents', async () => {
		writeSkillDir(join(home, '.config', 'opencode', 'skills'), 'alpha');
		writeSkillDir(join(home, '.claude', 'skills'), 'claude-only');
		writeSkillDir(join(home, '.agents', 'skills'), 'agents-only');
		writeSkillDir(join(home, '.opencode', 'skills'), 'dot-opencode');

		const config = await SkillService.getAllSkills(null, { homeDir: home });
		const ids = Object.keys(config.global).sort();

		assert.deepStrictEqual(ids, [
			'global-agents-only',
			'global-alpha',
			'global-claude-only',
			'global-dot-opencode',
		]);
	});

	test('dedupes by skillId with opencode directories winning over .claude', async () => {
		writeSkillDir(join(home, '.claude', 'skills'), 'shared', 'claude-version');
		writeSkillDir(join(home, '.config', 'opencode', 'skills'), 'shared', 'opencode-version');

		const config = await SkillService.getAllSkills(null, { homeDir: home });
		const skills = Object.values(config.global).filter((s) => s.skillId === 'shared');

		assert.strictEqual(skills.length, 1, 'duplicate skillId must collapse to one entry');
		assert.strictEqual(skills[0].name, 'opencode-version');
		assert.ok(skills[0].sourceDir.includes('.config'));
	});

	test('accepts v2 root markdown files and grouped directories', async () => {
		const root = join(home, '.config', 'opencode', 'skills');
		writeSkillFile(root, 'flat-skill.md', 'flat-skill');
		writeSkillDir(join(root, 'teams', 'release'), 'release', 'release');
		mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
		writeFileSync(join(root, 'node_modules', 'ignored', 'SKILL.md'), SKILL_MD('ignored'), 'utf-8');
		mkdirSync(join(root, '.hidden'), { recursive: true });
		writeFileSync(join(root, '.hidden', 'SKILL.md'), SKILL_MD('hidden'), 'utf-8');

		const config = await SkillService.getAllSkills(null, { homeDir: home });

		const flat = config.global['global-flat-skill'];
		assert.ok(flat, 'root-level .md must be a file skill');
		assert.strictEqual(flat.type, 'file');

		const nested = config.global['global-release'];
		assert.ok(nested, 'grouped directory must be discovered');
		assert.strictEqual(nested.type, 'directory');
		assert.strictEqual(nested.skillId, 'release');

		assert.strictEqual(config.global['global-ignored'], undefined);
		assert.strictEqual(config.global['global-hidden'], undefined);
	});

	test('marks disabled skills and keeps them out of collisions with active ones', async () => {
		const workspace = makeTempDir('skills-ws-');
		try {
			writeSkillDir(join(workspace, '.opencode', 'skills'), 'local-active');
			writeSkillDir(join(workspace, '.opencode', 'skills-disabled'), 'local-off');

			const config = await SkillService.getAllSkills(workspace, { homeDir: home });

			assert.strictEqual(config.local['local-local-active']?.enabled, true);
			assert.strictEqual(config.local['local-local-off-disabled']?.enabled, false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

suite('SkillService delete/toggle by skillId', () => {
	let workspace: string;

	setup(() => {
		workspace = makeTempDir('skills-ws-');
		mkdirSync(join(workspace, '.opencode', 'skills'), { recursive: true });
	});

	teardown(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test('deletes a skill whose display name differs from its directory name', async () => {
		writeSkillDir(join(workspace, '.opencode', 'skills'), 'git-release', 'Git Release');
		const config = await SkillService.getAllSkills(workspace);
		const skill = config.local['local-git-release'];
		assert.ok(skill);

		const result = await SkillService.deleteSkill(
			skill.skillId,
			'local',
			true,
			workspace,
			skill.path,
		);

		assert.strictEqual(result.success, true, result.error);
		assert.strictEqual(existsSync(join(workspace, '.opencode', 'skills', 'git-release')), false);
	});

	test('moves a skill to the disabled directory and back', async () => {
		writeSkillDir(join(workspace, '.opencode', 'skills'), 'toggle-me');
		const activePath = join(workspace, '.opencode', 'skills', 'toggle-me');
		const disabledPath = join(workspace, '.opencode', 'skills-disabled', 'toggle-me');

		const disabled = await SkillService.toggleSkill('toggle-me', 'local', true, workspace, activePath);
		assert.strictEqual(disabled.success, true, disabled.error);
		assert.strictEqual(existsSync(activePath), false);
		assert.strictEqual(existsSync(disabledPath), true);

		const enabled = await SkillService.toggleSkill('toggle-me', 'local', false, workspace, disabledPath);
		assert.strictEqual(enabled.success, true, enabled.error);
		assert.strictEqual(existsSync(activePath), true);
		assert.strictEqual(existsSync(disabledPath), false);
	});

	test('toggles a root-level markdown skill without losing its extension', async () => {
		const root = join(workspace, '.opencode', 'skills');
		writeSkillFile(root, 'flat.md', 'flat');

		const disabled = await SkillService.toggleSkill('flat', 'local', true, workspace, join(root, 'flat.md'));
		assert.strictEqual(disabled.success, true, disabled.error);
		assert.strictEqual(existsSync(join(workspace, '.opencode', 'skills-disabled', 'flat.md')), true);

		const enabled = await SkillService.toggleSkill(
			'flat',
			'local',
			false,
			workspace,
			join(workspace, '.opencode', 'skills-disabled', 'flat.md'),
		);
		assert.strictEqual(enabled.success, true, enabled.error);
		assert.strictEqual(existsSync(join(root, 'flat.md')), true);
	});

	test('rejects a delete request outside the skills roots', async () => {
		const outside = join(workspace, 'not-a-skill');
		mkdirSync(outside, { recursive: true });

		const result = await SkillService.deleteSkill('not-a-skill', 'local', true, workspace, outside);

		assert.strictEqual(result.success, false);
		assert.strictEqual(existsSync(outside), true);
	});
});
