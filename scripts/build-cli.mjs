import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'cli');

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await run('go', ['mod', 'download'], { cwd: join(root, 'cli') });

const flags = `-s -w -X main.version=${packageJson.version}`;
for (const target of [
  { os: 'darwin', arch: 'arm64', name: 'geo-publisher-darwin-arm64' },
  { os: 'windows', arch: 'amd64', name: 'geo-publisher-windows-amd64.exe' },
]) {
  await run('go', ['build', '-trimpath', `-ldflags=${flags}`, '-o', join(output, target.name), '.'], {
    cwd: join(root, 'cli'),
    env: { ...process.env, GOOS: target.os, GOARCH: target.arch },
  });
}

console.log(`Built CLI binaries in ${output}`);
