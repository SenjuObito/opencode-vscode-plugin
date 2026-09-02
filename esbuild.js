const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log(`[watch] build started (${build.initialOptions.entryPoints[0]})`);
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log(`[watch] build finished (${build.initialOptions.entryPoints[0]})`);
		});
	},
};

/**
 * Bundles the extension host code (runs in Node).
 *
 * The webview is a separate Vite project (`webview/`) that emits a single-file
 * bundle to `dist/webview/index.html`; the ai-bridge daemon is spawned as ESM
 * directly from `ai-bridge/daemon.js` (its own package + node_modules). Only
 * the extension host is bundled here.
 */
const extensionConfig = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	outfile: 'dist/extension.js',
	external: ['vscode'],
	logLevel: 'silent',
	plugins: [
		/* add to the end of plugins array */
		esbuildProblemMatcherPlugin,
	],
};

async function main() {
	if (watch) {
		const context = await esbuild.context(extensionConfig);
		await context.watch();
	} else {
		await esbuild.build(extensionConfig);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
