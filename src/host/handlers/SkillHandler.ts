/**
 * SkillHandler — opencode skill management handler.
 *
 * Handles 5 wire message types:
 *   get_all_skills  → scan skills dir, return full config
 *   import_skill    → show file dialog, copy to skills dir
 *   delete_skill    → validate + delete skill directory
 *   toggle_skill    → move between enabled/disabled dirs
 *   open_skill      → open SKILL.md in VS Code editor
 *
 * Port of cc-gui `handler/SkillHandler.java` for opencode-only.
 */
import * as vscode from 'vscode';
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { SkillService } from '../services/SkillService';
import type { SkillScope } from '../services/SkillService';

const SUPPORTED_TYPES = ['get_all_skills', 'import_skill', 'delete_skill', 'toggle_skill', 'open_skill'];

export class SkillHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'get_all_skills':
				void this.handleGetAllSkills();
				return true;
			case 'import_skill':
				void this.handleImportSkill(content);
				return true;
			case 'delete_skill':
				void this.handleDeleteSkill(content);
				return true;
			case 'toggle_skill':
				void this.handleToggleSkill(content);
				return true;
			case 'open_skill':
				void this.handleOpenSkill(content);
				return true;
			default:
				return false;
		}
	}

	// ── get_all_skills ────────────────────────────────────────────────────

	private async handleGetAllSkills(): Promise<void> {
		try {
			const workspaceRoot = this.context.resolveEffectiveWorkingDirectory();
			const config = await SkillService.getAllSkills(workspaceRoot);
			this.callJavaScript('updateSkills', JSON.stringify(config));
		} catch (err) {
			console.error('[SkillHandler] get_all_skills failed:', err);
			this.callJavaScript('updateSkills', JSON.stringify({ global: {}, local: {}, user: {}, repo: {} }));
		}
	}

	// ── import_skill ──────────────────────────────────────────────────────

	private async handleImportSkill(content: string): Promise<void> {
		let scope: SkillScope = 'global';
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			if (typeof json.scope === 'string') {
				scope = json.scope as SkillScope;
			}
		} catch {
			// use default
		}

		// Show VS Code native file/folder picker
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: true,
			canSelectMany: true,
			openLabel: 'Import Skill',
			title: 'Select skill files or directories to import',
		});

		if (!uris || uris.length === 0) {
			// User cancelled
			return;
		}

		const sourcePaths = uris.map((uri) => uri.fsPath);

		try {
			const workspaceRoot = this.context.resolveEffectiveWorkingDirectory();
			const result = await SkillService.importSkills(sourcePaths, scope, workspaceRoot);
			this.callJavaScript('skillImportResult', JSON.stringify(result));

			// Refresh skill list after import
			if (result.count > 0) {
				await this.handleGetAllSkills();
			}
		} catch (err) {
			console.error('[SkillHandler] import_skill failed:', err);
			this.callJavaScript('skillImportResult', JSON.stringify({
				success: false,
				count: 0,
				total: sourcePaths.length,
				imported: [],
				errors: [String(err)],
			}));
		}
	}

	// ── delete_skill ──────────────────────────────────────────────────────

	private async handleDeleteSkill(content: string): Promise<void> {
		let name = '';
		let scope: SkillScope = 'global';
		let enabled = true;

		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			if (typeof json.name === 'string') {
				name = json.name;
			}
			if (typeof json.scope === 'string') {
				scope = json.scope as SkillScope;
			}
			if (typeof json.enabled === 'boolean') {
				enabled = json.enabled;
			}
		} catch {
			// invalid payload
		}

		if (!name) {
			this.callJavaScript('skillDeleteResult', JSON.stringify({
				success: false,
				error: 'Missing skill name',
			}));
			return;
		}

		// Confirm deletion
		const confirm = await vscode.window.showWarningMessage(
			`Delete skill "${name}"? This cannot be undone.`,
			{ modal: true },
			'Delete',
		);

		if (confirm !== 'Delete') {
			this.callJavaScript('skillDeleteResult', JSON.stringify({
				success: false,
				error: 'Cancelled by user',
			}));
			return;
		}

		try {
			const workspaceRoot = this.context.resolveEffectiveWorkingDirectory();
			const result = await SkillService.deleteSkill(name, scope, enabled, workspaceRoot);
			this.callJavaScript('skillDeleteResult', JSON.stringify(result));

			// Refresh skill list after deletion
			if (result.success) {
				await this.handleGetAllSkills();
			}
		} catch (err) {
			console.error('[SkillHandler] delete_skill failed:', err);
			this.callJavaScript('skillDeleteResult', JSON.stringify({
				success: false,
				error: String(err),
			}));
		}
	}

	// ── toggle_skill ──────────────────────────────────────────────────────

	private async handleToggleSkill(content: string): Promise<void> {
		let name = '';
		let scope: SkillScope = 'global';
		let currentEnabled = true;

		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			if (typeof json.name === 'string') {
				name = json.name;
			}
			if (typeof json.scope === 'string') {
				scope = json.scope as SkillScope;
			}
			if (typeof json.enabled === 'boolean') {
				currentEnabled = json.enabled;
			}
		} catch {
			// invalid payload
		}

		if (!name) {
			this.callJavaScript('skillToggleResult', JSON.stringify({
				success: false,
				error: 'Missing skill name',
			}));
			return;
		}

		try {
			const workspaceRoot = this.context.resolveEffectiveWorkingDirectory();
			const result = await SkillService.toggleSkill(name, scope, currentEnabled, workspaceRoot);
			this.callJavaScript('skillToggleResult', JSON.stringify({
				...result,
				name,
				enabled: !currentEnabled,
			}));

			// Refresh skill list after toggle
			if (result.success) {
				await this.handleGetAllSkills();
			}
		} catch (err) {
			console.error('[SkillHandler] toggle_skill failed:', err);
			this.callJavaScript('skillToggleResult', JSON.stringify({
				success: false,
				error: String(err),
			}));
		}
	}

	// ── open_skill ────────────────────────────────────────────────────────

	private async handleOpenSkill(content: string): Promise<void> {
		let path = '';
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			if (typeof json.path === 'string') {
				path = json.path;
			}
		} catch {
			path = content;
		}

		if (!path) {
			return;
		}

		const openPath = await SkillService.resolveOpenPath(path);
		if (openPath) {
			this.context.getFileOps().openFile(openPath);
		} else {
			vscode.window.showWarningMessage(`Skill file not found: ${path}`);
		}
	}
}
