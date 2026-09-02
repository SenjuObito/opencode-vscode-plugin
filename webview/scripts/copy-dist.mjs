import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const distFile = path.resolve(cwd, 'dist/index.html');
// VS Code extension: copy the single-file bundle where the extension host reads it.
const targetFile = path.resolve(cwd, '../dist/webview/index.html');

const main = async () => {
  const html = await readFile(distFile, 'utf-8');
  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, html, 'utf-8');
  console.log(`[copy-dist] 已同步 ${distFile} -> ${targetFile}`);
};

main().catch((error) => {
  console.error('[copy-dist] 复制构建产物失败', error);
  process.exit(1);
});

