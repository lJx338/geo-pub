import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { storeVersion as resolveStoreVersion } from './store-version.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const versionFlag = args.findIndex((arg) => arg === '--store-version');
const requestedVersion = versionFlag >= 0 ? args[versionFlag + 1] : process.env.STORE_PACKAGE_VERSION;
const storeVersion = resolveStoreVersion(requestedVersion);

if (!/^\d+\.\d+\.\d+$/.test(storeVersion)) {
  throw new Error(`商店版本必须是三段数字，例如 1.0.0；收到：${storeVersion}`);
}

const parts = storeVersion.split('.').map(Number);
if (parts[0] < 1 || parts.some((part) => part < 0 || part > 65535)) {
  throw new Error(`商店版本超出 MSIX 范围：${storeVersion}`);
}

console.log(`应用版本：${packageJson.version}`);
console.log(`MSIX 包版本：${storeVersion}.0`);

if (process.platform !== 'win32') {
  throw new Error('请在安装了 Windows SDK 的 Windows 环境中构建微软商店包。');
}

const output = path.resolve('release/store');
await mkdir(output, { recursive: true });
const staging = await mkdtemp(path.join(output, '.msix-'));
try {
  await run(process.execPath, [
    'node_modules/electron-builder/cli.js',
    '--config', 'scripts/windows-config.mjs',
    '--win', 'appx',
    '--x64',
    '--publish', 'never',
    `--config.directories.output=${staging}`,
    `--config.extraMetadata.version=${storeVersion}`,
  ]);

  const packages = (await readdir(staging)).filter((file) => /\.(?:appx|msix)$/i.test(file));
  if (packages.length !== 1) throw new Error(`应当生成一个商店包，实际生成 ${packages.length} 个。`);
  const [file] = packages;
  await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/finalize-store-package.ps1',
    '-InputPackage', path.join(staging, file),
    '-OutputPackage', path.join(output, file),
  ]);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function run(command, args) {
  const [code, signal] = await once(spawn(command, args, { stdio: 'inherit' }), 'exit');
  if (code !== 0) throw new Error(`${command} 执行失败（${signal || code}）。`);
}
