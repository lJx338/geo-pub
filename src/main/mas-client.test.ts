import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MasCliBridge, type CliResult } from './mas-cli-bridge.js';
import { ControlServer } from './control-server.js';
import type { ControlRequest } from '../shared/protocol.js';
import packageJson from '../../package.json' with { type: 'json' };

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; vi.unstubAllEnvs(); });

// Executed by the macOS workflow against the real system JXA client and real production Go CLI.
// This checks the transport, not the signed app's sandbox or third-party publishing pages.
describe.skipIf(process.platform !== 'darwin')('macOS WorkBuddy client', () => {
  it('preserves commands, stderr, local JSON/material files and stdin through the real CLI', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'geo-mas-client-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    vi.stubEnv('GEO_PUBLISHER_USER_DATA_DIR', dataDir);
    vi.stubEnv('GEO_PUBLISHER_CONTROL_ENDPOINT', 'tcp://127.0.0.1:0');
    const token = 'b'.repeat(64);
    await writeFile(join(dataDir, 'control-token.json'), JSON.stringify({ token }));
    const received: ControlRequest[] = [];
    const control = new ControlServer(token, async request => { received.push(request); return { received: request.action }; });
    const endpoint = await control.start();
    cleanups.push(() => control.stop());
    const bridge = new MasCliBridge({ token, dataDir, helper: resolve('dist/cli/geo-publisher-darwin-arm64'), endpoint });
    await bridge.start();
    cleanups.push(() => bridge.stop());
    const client = resolve('integrations/mas-cli/geo-publisher');
    const run = (args: string[], stdin = ''): Promise<CliResult> => new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [client, ...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      child.stdin.end(stdin);
    });
    const status = await run(['status']);
    expect(status.stderr).toBe('');
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).ok).toBe(true);
    const sourceVersion = process.env.GEO_BUILD_VERSION || packageJson.version;
    const expectedVersion = sourceVersion.split('.').length === 2 ? `${sourceVersion}.0` : sourceVersion;
    expect(JSON.parse(status.stdout).version).toBe(expectedVersion);
    expect(received[0]?.action).toBe('status');
    const start = await run(['start']);
    expect(start.exitCode).toBe(0);
    expect(received.at(-1)?.action).toBe('app.show');
    const invalid = await run(['not-a-command']);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stderr).ok).toBe(false);
    const project = '9f23d09e-e0ae-4423-9ad4-593fd6299b99';
    const material = join(dataDir, "WorkBuddy's 封面.jpg");
    await writeFile(material, 'test image');
    const imported = await run(['content', 'import-material', project, '--path', material]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    const last = received.at(-1);
    expect(last?.action).toBe('content.import-material');
    if (last?.action === 'content.import-material') {
      expect(last.sourcePath).toContain('bridge-imports');
      expect(await readFile(last.sourcePath, 'utf8')).toBe('test image');
    }
    const input = join(dataDir, 'article input.json');
    await writeFile(input, JSON.stringify({ kind: 'article', title: '中文标题', payload: { coverPath: material } }));
    const saved = await run(['content', 'save', project, '--input', input]);
    expect(saved.exitCode, saved.stderr).toBe(0);
    expect(received.at(-1)?.action).toBe('content.save');
    // Malformed stdin must return the CLI's own JSON error, never hang on stdin.
    const validated = await run(['validate'], '{}');
    expect(validated.exitCode).toBe(1);
    expect(JSON.parse(validated.stderr).ok).toBe(false);
  }, 60_000);
});
