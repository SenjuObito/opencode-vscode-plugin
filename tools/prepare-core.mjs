/**
 * tools/prepare-core.mjs
 *
 * 准备 opencode-buddy-core 运行时到 dist/opencode-buddy-core/，用于打包 VSIX。
 *
 * 优先级策略：
 * 1. 环境变量 OPENCODE_DEV_BRIDGE_ZIP：指定了已存在的 zip 则直接解压
 * 2. 本地同级目录 ../opencode-buddy-core：若存在，自动通过 npm run pack:zip 打包本地最新代码并解压
 * 3. 远端下载（CI / 纯净环境）：从 GitHub Release 下载 ai-bridge.zip 并解压
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const targetCoreDir = join(rootDir, 'dist', 'opencode-buddy-core');
const siblingCoreDir = resolve(rootDir, '..', 'opencode-buddy-core');

console.log('[prepare-core] Target directory:', targetCoreDir);

// 读取 package.json 中 opencode-buddy-core 的版本 / tag
function getCoreTag() {
	try {
		const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
		const dep = pkg.dependencies?.['opencode-buddy-core'] || '';
		const match = dep.match(/#(v?[0-9.]+.*)$/);
		if (match) {
			return match[1].startsWith('v') ? match[1] : `v${match[1]}`;
		}
	} catch (e) {
		// fallback
	}
	return 'v1.0.0';
}

function extractZip(zipPath, destDir) {
	console.log(`[prepare-core] Extracting ${zipPath} to ${destDir}...`);
	if (existsSync(destDir)) {
		rmSync(destDir, { recursive: true, force: true });
	}
	mkdirSync(destDir, { recursive: true });

	if (process.platform === 'win32') {
		execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, {
			stdio: 'inherit',
		});
	} else {
		execSync(`unzip -q -o "${zipPath}" -d "${destDir}"`, {
			stdio: 'inherit',
		});
	}
}

async function downloadFile(url, destPath) {
	console.log(`[prepare-core] Downloading from ${url}...`);
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
	}
	const arrayBuffer = await response.arrayBuffer();
	writeFileSync(destPath, Buffer.from(arrayBuffer));
	console.log(`[prepare-core] Downloaded ${(arrayBuffer.byteLength / 1024).toFixed(1)} KB`);
}

async function main() {
	// 确保 dist 目录存在
	mkdirSync(join(rootDir, 'dist'), { recursive: true });

	// 优先级 1: 环境变量指定 ZIP
	const customZip = process.env.OPENCODE_DEV_BRIDGE_ZIP;
	if (customZip && existsSync(customZip)) {
		console.log(`[prepare-core] Priority 1: Using custom zip from env: ${customZip}`);
		extractZip(customZip, targetCoreDir);
		verify();
		return;
	}

	// 优先级 2: 本地同级仓库 ../opencode-buddy-core
	if (existsSync(siblingCoreDir) && existsSync(join(siblingCoreDir, 'daemon.js'))) {
		console.log(`[prepare-core] Priority 2: Found local sibling core repo at ${siblingCoreDir}`);
		const localZip = join(siblingCoreDir, 'dist', 'ai-bridge.zip');
		const packScript = join(siblingCoreDir, 'scripts', 'pack-zip.mjs');

		// 检查是否需要重新打包 local zip
		let needPack = !existsSync(localZip);
		if (!needPack && existsSync(packScript)) {
			const zipTime = readFileSync(localZip); // check readable
			const keyFiles = [
				join(siblingCoreDir, 'daemon.js'),
				join(siblingCoreDir, 'package.json'),
				packScript,
			];
			// 如果源码比 zip 新，重新构建
			const { statSync } = await import('node:fs');
			const zipMtime = statSync(localZip).mtimeMs;
			needPack = keyFiles.some((f) => existsSync(f) && statSync(f).mtimeMs > zipMtime);
		}

		if (needPack && existsSync(packScript)) {
			console.log('[prepare-core] Packaging local opencode-buddy-core into zip...');
			execSync('npm run pack:zip', { cwd: siblingCoreDir, stdio: 'inherit' });
		}

		if (existsSync(localZip)) {
			extractZip(localZip, targetCoreDir);
			verify();
			return;
		}
	}

	// 优先级 3: 从 GitHub Release 下载
	const tag = getCoreTag();
	const downloadUrl = `https://github.com/SenjuObito/opencode-buddy-core/releases/download/${tag}/ai-bridge.zip`;
	const tempZip = join(rootDir, 'dist', `core-${tag}.zip`);

	console.log(`[prepare-core] Priority 3: Remote fallback from GitHub release (${tag})...`);
	try {
		await downloadFile(downloadUrl, tempZip);
		extractZip(tempZip, targetCoreDir);
		rmSync(tempZip, { force: true });
		verify();
	} catch (err) {
		console.error(`[prepare-core] Failed to download or extract remote release: ${err.message}`);
		process.exit(1);
	}
}

function verify() {
	const daemonFile = join(targetCoreDir, 'daemon.js');
	const sdkDir = join(targetCoreDir, 'node_modules', '@opencode-ai', 'sdk');
	if (!existsSync(daemonFile)) {
		console.error(`[prepare-core] Error: daemon.js not found at ${daemonFile}`);
		process.exit(1);
	}
	if (!existsSync(sdkDir)) {
		console.error(`[prepare-core] Error: @opencode-ai/sdk not found at ${sdkDir}`);
		process.exit(1);
	}
	console.log(`[prepare-core] ✓ opencode-buddy-core runtime successfully prepared at: ${targetCoreDir}`);
}

main().catch((err) => {
	console.error('[prepare-core] Uncaught error:', err);
	process.exit(1);
});
