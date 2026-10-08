import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ControlServer } from './control-server.js';
import { MasCliBridge, prepareBridgeInput } from './mas-cli-bridge.js';

const directories: string[] = [];
const bridges: MasCliBridge[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'geo-mas-test-')); directories.push(path); return path; }
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.stop(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('MAS CLI bridge', () => {
  const nativeHelper = join(process.cwd(), 'dist', 'cli', process.platform === 'win32' ? 'geo-publisher-windows-amd64.exe' : 'geo-publisher-darwin-arm64');
  it.skipIf(!existsSync(nativeHelper) || !['win32', 'darwin'].includes(process.platform))('runs the production Go helper through authenticated loopback control', async () => {
    const dataDir = await directory(), token = 'c'.repeat(64);
    vi.stubEnv('GEO_PUBLISHER_CONTROL_ENDPOINT', 'tcp://127.0.0.1:0');
    await writeFile(join(dataDir, 'control-token.json'), JSON.stringify({ token }));
    const actions: string[] = [];
    const control = new ControlServer(token, async request => { actions.push(request.action); return { ready: true }; });
    const endpoint = await control.start();
    const bridge = new MasCliBridge({ dataDir, token, helper: nativeHelper, endpoint });
    bridges.push(bridge);
    try {
      const url = await bridge.start();
      for (const command of ['status', 'start']) {
        const response = await fetch(`${url}/v1/cli`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ args: [command] }) });
        const result = await response.json();
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).ok).toBe(true);
      }
      expect(actions).toEqual(['status', 'app.show']);
    } finally { await bridge.stop(); await control.stop(); }
  });
  it('imports local cover bytes and rewrites JSON inputs to durable sandbox files', async () => {
    const dataDir = await directory();
    const cover = '/external folder/封面.jpg';
    const input = '/external folder/article.json';
    const prepared = await prepareBridgeInput({ args: ['content', 'save', 'project', '--input', input], files: [
      { path: input, json: true, base64: Buffer.from(JSON.stringify({ payload: { coverPath: cover }, title: '中文标题' })).toString('base64') },
      { path: cover, base64: Buffer.from('image bytes').toString('base64') },
    ] }, dataDir);
    const article = JSON.parse(await readFile(prepared.args[4]!, 'utf8'));
    expect(article.title).toBe('中文标题');
    expect(article.payload.coverPath).toContain(dataDir);
    expect(await readFile(article.payload.coverPath, 'utf8')).toBe('image bytes');
    const again = await prepareBridgeInput({ args: [], stdin: JSON.stringify({ coverPath: cover }), files: [{ path: cover, base64: Buffer.from('image bytes').toString('base64') }] }, dataDir);
    expect(JSON.parse(again.stdin).coverPath).toBe(article.payload.coverPath);
  });

  it('prevents uploaded names escaping the import directory and rejects malformed encoding', async () => {
    const dataDir = await directory();
    const prepared = await prepareBridgeInput({ args: ['--path', '../../outside'], files: [{ path: '../../outside', base64: 'YQ==' }] }, dataDir);
    expect(prepared.args[1]).toContain(join(dataDir, 'bridge-imports'));
    await expect(prepareBridgeInput({ args: [], files: [{ path: 'a', base64: '!!' }] }, dataDir)).rejects.toThrow('encoding');
  });

  it('requires the local token, rejects browser origins and preserves result streams and status', async () => {
    const dataDir = await directory(), token = 'a'.repeat(64);
    const execute = vi.fn(async () => ({ stdout: '', stderr: '{"ok":false}', exitCode: 1 }));
    const bridge = new MasCliBridge({ dataDir, token, helper: 'unused', endpoint: 'unused', execute }); bridges.push(bridge);
    const url = await bridge.start();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const body = JSON.stringify({ args: ['publish', '--input', 'missing.json'] });
    expect((await fetch(`${url}/v1/cli`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(403);
    expect((await fetch(`${url}/v1/cli`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body })).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    const result = await fetch(`${url}/v1/cli`, { method: 'POST', headers, body });
    expect(await result.json()).toEqual({ stdout: '', stderr: '{"ok":false}', exitCode: 1 });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]).toEqual([['publish', '--input', 'missing.json'], '', expect.any(AbortSignal)]);
    await bridge.stop();
    await expect(readFile(join(dataDir, 'mas-cli-bridge.json'))).rejects.toThrow();
  });
});
