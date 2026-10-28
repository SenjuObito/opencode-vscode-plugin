import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

describe('Multi-Session Architecture Guardrails', () => {
	// Look at the source tree src/host/tab
	const tabDir = path.resolve(__dirname, '../../src/host/tab');

	it('should ensure src/host/tab directory exists and has all core modules', () => {
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

	it('should forbid legacy single-session commands in src/host/tab/', () => {
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
});
