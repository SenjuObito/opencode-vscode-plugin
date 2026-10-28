// Minimal mock for running tests directly with mocha in pure node
try {
	require('vscode');
} catch {
	const Module = require('module');
	const origResolve = Module._resolveFilename;
	Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
		if (request === 'vscode') {
			return 'vscode';
		}
		return origResolve.call(this, request, parent, isMain, options);
	};
	require.cache['vscode'] = {
		id: 'vscode',
		filename: 'vscode',
		loaded: true,
		exports: {
			window: {
				createOutputChannel: () => ({
					appendLine: () => {},
					append: () => {},
					show: () => {},
					clear: () => {},
				}),
				showErrorMessage: () => Promise.resolve(),
				showInformationMessage: () => Promise.resolve(),
			},
			workspace: {
				workspaceFolders: [],
				fs: {
					stat: () => Promise.resolve({ type: 1 }),
				},
			},
			env: {
				clipboard: {
					writeText: () => Promise.resolve(),
					readText: () => Promise.resolve(''),
				},
				openExternal: () => Promise.resolve(true),
			},
			Uri: {
				file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
			},
		},
	} as unknown as NodeModule;
}
