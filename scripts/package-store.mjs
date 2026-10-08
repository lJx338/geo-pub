import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(command, [
  'electron-builder',
  '--win',
  'appx',
  '--x64',
  '--publish',
  'never',
  '--config.directories.output=release/store',
  `--config.extraMetadata.version=${storeVersion}`,
], { stdio: 'inherit', shell: process.platform === 'win32' });

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`electron-builder 被信号 ${signal} 终止`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
