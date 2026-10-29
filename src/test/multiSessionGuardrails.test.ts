import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('Multi-Session Architecture Guardrails', () => {
	// Look at the source tree src/host/tab
	const tabDir = path.resolve(__dirname, '../../src/host/tab');

	test('should ensure src/host/tab directory exists and has all core modules', () => {
		assert.ok(fs.existsSync(tabDir), 'src/host/tab must exist');
		const files = fs.readdirSync(tabDir);
		const expectedModules = [
			'TabId.ts',
			'SessionId.ts',
			'TurnId.ts',
			'TabState.ts',
			'TabSettings.ts',
			'TabSnapshot.ts',
			'TabEvent.ts',
			'TabRecord.ts',
			'TabSessionActor.ts',
			'TabRegistry.ts',
			'PendingSend.ts',
			'TabStreamRouter.ts',
			'TabCommand.ts',
			'TabCommandRouter.ts',
			'TabSessionFactory.ts',
		];

		for (const mod of expectedModules) {
			assert.ok(files.includes(mod), `src/host/tab must contain ${mod}`);
		}
	});

	test('should forbid legacy single-session commands in src/host/tab/', () => {
		const files = fs.readdirSync(tabDir).filter((f) => f.endsWith('.ts'));
		for (const file of files) {
			const content = fs.readFileSync(path.join(tabDir, file), 'utf-8');
			assert.ok(
				!content.includes('create_new_session'),
				`File ${file} should not reference legacy 'create_new_session'`,
			);
			assert.ok(
				!content.includes('switch_session'),
				`File ${file} should not reference legacy 'switch_session'`,
			);
			assert.ok(
				!content.includes('context.getSession()'),
				`File ${file} should not call global 'context.getSession()'`,
			);
		}
	});

	test('should keep prompt attribution free of active-session fallbacks', () => {
		const permissionHandler = path.resolve(
			__dirname,
			'../../src/host/handlers/PermissionHandler.ts',
		);
		const content = fs.readFileSync(permissionHandler, 'utf-8');
		assert.ok(
			!content.includes('getSession()?.state.getSessionId()'),
			'PermissionHandler must not borrow the active session for a prompt',
		);
	});

	test('should keep the webview off legacy window-level sends', () => {
		const bridge = path.resolve(__dirname, '../../webview/src/utils/bridge.ts');
		const content = fs.readFileSync(bridge, 'utf-8');
		assert.ok(
			!content.includes("'send_message'"),
			'bridge must not fall back to legacy send_message',
		);
		assert.ok(
			!content.includes("'interrupt_session'"),
			'bridge must not fall back to legacy interrupt_session',
		);
	});
});
