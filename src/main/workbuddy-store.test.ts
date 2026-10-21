import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkBuddyIntegration, prepareWorkBuddyMaterialOrganization, workBuddyIntegrationStatus } from './workbuddy-integration.js';
import { ControlServer } from './control-server.js';
import packageJson from '../../package.json' with { type: 'json' };

const electron = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: vi.fn(), getName: () => 'Lingxi Workspace' },
  clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn() },
}));
vi.mock('electron', () => electron);
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalStore = Object.getOwnPropertyDescriptor(process, 'windowsStore');
const nativeHelper = originalPlatform.value === 'win32'
  ? join(process.cwd(), 'dist', 'cli', 'geo-publisher-windows-amd64.exe')
  : join(process.cwd(), 'dist', 'cli', 'geo-publisher-darwin-arm64');
const runFile = promisify(execFile);
let temporary: string, physical: string, logical: string, cli: string;
const skills = ['geo-publisher', 'geo-customer-profile', 'geo-topic-planner', 'geo-article-writer', 'geo-material-organizer'];

beforeEach(async () => {
  vi.clearAllMocks();
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'geo-store-paths-')));
  physical = join(temporary, 'actual-package', 'LocalCache', 'Local', 'GEO Publisher Desktop');
  logical = join(temporary, 'virtual-appdata', 'GEO Publisher Desktop');
  await mkdir(physical, { recursive: true });
  await mkdir(join(temporary, 'virtual-appdata'));
  // Model AppData redirection with a junction; the external paths must resolve
  // to the same actual files, not merely contain a particular package name.
  await symlink(physical, logical, 'junction');
  cli = join(logical, 'bin', 'versions', '1.0.14', 'geo-publisher.exe');
  await mkdir(join(cli, '..'), { recursive: true });
  await writeFile(cli, 'test executable');
  await writeFile(join(logical, 'discovery.json'), '{}');
  await writeFile(join(logical, 'control-token.json'), '{}');
  vi.stubEnv('GEO_PUBLISHER_USER_DATA_DIR', logical);
  vi.stubEnv('GEO_DISABLE_OPEN_WORKBUDDY', '1');
  electron.app.getAppPath.mockReturnValue(process.cwd());
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'windowsStore', { value: true, configurable: true });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform);
  if (originalStore) Object.defineProperty(process, 'windowsStore', originalStore);
  else Reflect.deleteProperty(process, 'windowsStore');
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

describe('WorkBuddy Store connection preparation', () => {
  it('exports readable physical CLI, five Skill paths and the connection file', async () => {
    const result = await prepareWorkBuddyIntegration(false, cli);
    expect(result.prepared).toBe(true);
    expect(result.prompt).toContain('Lingxi Workspace 安装位置');
    expect(result.prompt).toContain(join(physical, 'bin', 'versions', '1.0.14', 'geo-publisher.exe'));
    expect(result.prompt).toContain(`$env:GEO_PUBLISHER_USER_DATA_DIR='${physical.replaceAll("'", "''")}'`);
    expect(result.prompt).not.toContain(logical);
    for (const skill of skills) {
      const directory = join(physical, 'integrations', 'workbuddy', skill);
      expect(result.prompt).toContain(directory);
      expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain(`name: ${skill}`);
    }
    expect(await readFile(result.promptPath!, 'utf8')).toBe(`${result.prompt}\n`);
    expect(await workBuddyIntegrationStatus()).toMatchObject({
      prepared: true, skillPath: join(physical, 'integrations', 'workbuddy', 'geo-publisher'),
      promptPath: join(physical, 'integrations', 'workbuddy', 'CONNECT-WORKBUDDY.txt'),
    });
    expect(electron.clipboard.writeText).toHaveBeenCalledWith(result.prompt);
  });

  it('also includes the physical data directory in material organization prompts', async () => {
    const result = await prepareWorkBuddyMaterialOrganization(cli);
    expect(result.prompt).toContain(`$env:GEO_PUBLISHER_USER_DATA_DIR='${physical.replaceAll("'", "''")}'`);
    expect(result.prompt).not.toContain(logical);
    expect(result.materialSkillPath).toBe(join(physical, 'integrations', 'workbuddy', 'geo-material-organizer'));
  });

  it('does not copy or open a misleading connection prompt when the CLI is missing', async () => {
    await expect(prepareWorkBuddyIntegration(false, null)).rejects.toThrow('CLI 未安装成功');
    await expect(prepareWorkBuddyMaterialOrganization(null)).rejects.toThrow('CLI 未安装成功');
    await rm(cli);
    await expect(prepareWorkBuddyIntegration(false, cli)).rejects.toThrow('连接文件无法访问');
    expect(electron.clipboard.writeText).not.toHaveBeenCalled();
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  it('keeps the original virtual path and command prefix for ordinary EXE installations', async () => {
    Object.defineProperty(process, 'windowsStore', { value: false, configurable: true });
    const result = await prepareWorkBuddyIntegration(false, cli);
    expect(result.skillPath).toBe(join(logical, 'integrations', 'workbuddy', 'geo-publisher'));
    expect(result.prompt).toContain(`CLI 调用前缀：& '${cli.replaceAll("'", "''")}'`);
    expect(result.prompt).not.toContain('$env:GEO_PUBLISHER_USER_DATA_DIR=');
  });

  it.skipIf(!['win32', 'darwin'].includes(originalPlatform.value) || !existsSync(nativeHelper))('connects an external production CLI using the exported data directory', async () => {
    await copyFile(nativeHelper, cli);
    await chmod(cli, 0o755);
    const token = 'c'.repeat(64);
    await writeFile(join(logical, 'control-token.json'), JSON.stringify({ token }));
    vi.stubEnv('GEO_PUBLISHER_CONTROL_ENDPOINT', 'tcp://127.0.0.1:0');
    const server = new ControlServer(token, async () => ({ ready: true }));
    try {
      const endpoint = await server.start();
      await writeFile(join(logical, 'discovery.json'), JSON.stringify({ appVersion: packageJson.version, controlEndpoint: endpoint }));
      const prepared = await prepareWorkBuddyIntegration(false, cli);
      const environment: NodeJS.ProcessEnv = { ...process.env };
      delete environment.GEO_PUBLISHER_CONTROL_ENDPOINT;
      delete environment.GEO_PUBLISHER_USER_DATA_DIR;
      const calls = originalPlatform.value === 'win32' ? [
        `${prepared.prompt.split('\n').find(line => line.startsWith('CLI 调用前缀：'))!.slice('CLI 调用前缀：'.length)} doctor --json`,
        prepared.prompt.match(/备用检查也必须先设置同一环境变量：(.+)。捕获并核对/)![1]!,
      ] : ['native'];
      for (const call of calls) {
        const output = originalPlatform.value === 'win32'
          ? await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', call], { env: environment, timeout: 15_000 })
          : await runFile(join(physical, 'bin', 'versions', '1.0.14', 'geo-publisher.exe'), ['doctor', '--json'], { env: { ...environment, GEO_PUBLISHER_USER_DATA_DIR: physical }, timeout: 15_000 });
        expect(output.stderr).toBe('');
        expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, data: { discoveryReadable: true, versionMatch: true, desktopConnected: true } });
      }
    } finally { await server.stop(); }
  });
});
