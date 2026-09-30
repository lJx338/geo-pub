import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'cli');
const developmentOutput = join(root, '.dev-cli');
const mode = process.argv[2] || 'production';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}

const targets = [
  { os: 'darwin', arch: 'arm64', name: 'geo-publisher-darwin-arm64' },
  { os: 'windows', arch: 'amd64', name: 'geo-publisher-windows-amd64.exe' },
];

async function build(targetOutput, buildMode, names) {
  await rm(targetOutput, { recursive: true, force: true });
  await mkdir(targetOutput, { recursive: true });
  await run('go', ['mod', 'download'], { cwd: join(root, 'cli') });
  for (const target of targets) {
    const environment = { ...process.env, GOOS: target.os, GOARCH: target.arch };
    const flags = `-s -w -X main.version=${packageJson.version} -X main.buildMode=${buildMode}`;
    await run('go', ['build', '-trimpath', `-ldflags=${flags}`, '-o', join(targetOutput, names(target))], {
      cwd: join(root, 'cli'),
      env: environment,
    });
  }
}

if (mode === 'production' || mode === 'all') {
  await build(output, 'production', (target) => target.name);
}
if (mode === 'development' || mode === 'all') {
  await build(developmentOutput, 'development', (target) => target.name.replace(/^geo-publisher/, 'geo-publisher-dev'));
}
if (!['production', 'development', 'all'].includes(mode)) {
  throw new Error(`Unknown CLI build mode: ${mode}`);
}

console.log(`Built ${mode} CLI binaries.`);
