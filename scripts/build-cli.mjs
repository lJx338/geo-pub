import { spawn } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'cli');
const temporaryOutput = `${output}.new`;

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}

await rm(temporaryOutput, { recursive: true, force: true });
await mkdir(temporaryOutput, { recursive: true });
await run('go', ['mod', 'download'], { cwd: join(root, 'cli') });

const coreFlags = `-s -w -X main.version=${packageJson.version}`;
for (const target of [
  { os: 'darwin', arch: 'arm64', launcher: 'geo-publisher-launcher-darwin-arm64', core: 'geo-publisher-core-darwin-arm64' },
  { os: 'windows', arch: 'amd64', launcher: 'geo-publisher-launcher-windows-amd64.exe', core: 'geo-publisher-core-windows-amd64.exe' },
]) {
  const environment = { ...process.env, GOOS: target.os, GOARCH: target.arch };
  await run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', join(temporaryOutput, target.launcher), './launcher'], {
    cwd: join(root, 'cli'),
    env: environment,
  });
  await run('go', ['build', '-trimpath', `-ldflags=${coreFlags}`, '-o', join(temporaryOutput, target.core), '.'], {
    cwd: join(root, 'cli'),
    env: environment,
  });
}

await rm(output, { recursive: true, force: true });
await rename(temporaryOutput, output);

console.log(`Built CLI binaries in ${output}`);
