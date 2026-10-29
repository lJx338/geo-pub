import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBundledCli } from './cli-installer.js';
import { createDiscoveryRecord, writeDiscoveryRecord } from './discovery.js';
import { externalDataDirectory } from './windows-store-paths.js';
import { loadOrCreateControlToken } from './auth.js';
import { ProjectStore } from './project-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const electron = vi.hoisted(() => ({ app: { isPackaged: true, getAppPath: vi.fn() } }));
vi.mock('electron', () => electron);
const properties = ['platform', 'arch', 'windowsStore', 'mas', 'resourcesPath'] as const;
const descriptors = properties.map(name => [name, Object.getOwnPropertyDescriptor(process, name)] as const);
let temporary: string, logical: string, physical: string, resources: string;
function set(name: string, value: unknown) { Object.defineProperty(process, name, { value, configurable: true }); }

beforeEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(actualFs.rename);
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'geo-cli-store-')));
  physical = join(temporary, 'package-profile', 'GEO Publisher Desktop');
  logical = join(temporary, 'virtual-profile');
  resources = join(temporary, 'resources');
  await mkdir(physical, { recursive: true });
  await symlink(physical, logical, 'junction');
  await mkdir(join(resources, 'cli'), { recursive: true });
  await writeFile(join(resources, 'cli', 'geo-publisher-windows-amd64.exe'), 'bundled Windows CLI');
  set('platform', 'win32'); set('arch', 'x64'); set('windowsStore', true); set('mas', false); set('resourcesPath', resources);
  vi.stubEnv('GEO_PUBLISHER_USER_DATA_DIR', logical);
});
afterEach(async () => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(process, name, descriptor);
    else Reflect.deleteProperty(process, name);
  }
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

describe('bundled CLI installation paths', () => {
  it('returns the actual Store path for new and already installed versions', async () => {
    const expected = join(physical, 'bin', 'versions', '1.0.14', 'geo-publisher.exe');
    expect(await installBundledCli('1.0.14')).toBe(expected);
    expect(await readFile(expected, 'utf8')).toBe('bundled Windows CLI');
    await writeFile(join(resources, 'cli', 'geo-publisher-windows-amd64.exe'), 'different bundle');
    expect(await installBundledCli('1.0.14')).toBe(expected);
    expect(await readFile(expected, 'utf8')).toBe('bundled Windows CLI');
  });

  it('starts CLI discovery and saves projects when MSIX logical renames return EXDEV', async () => {
    vi.mocked(rename).mockImplementation(async (source, target) => {
      if (String(source).startsWith(logical) || String(target).startsWith(logical)) {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      }
      await actualFs.rename(source, target);
    });
    const cli = await installBundledCli('1.0.16');
    expect(cli).toBe(join(physical, 'bin', 'versions', '1.0.16', 'geo-publisher.exe'));
    expect(await readFile(cli!, 'utf8')).toBe('bundled Windows CLI');
    expect(JSON.parse(await readFile(join(cli!, '..', 'version.json'), 'utf8')).version).toBe('1.0.16');
    await loadOrCreateControlToken();
    for (const ready of [true, false, true]) {
      await writeDiscoveryRecord(createDiscoveryRecord('1.0.16', cli, ready));
      expect(JSON.parse(await readFile(join(logical, 'discovery.json'), 'utf8'))).toMatchObject({ cliPath: cli, ready });
      expect(await externalDataDirectory()).toBe(physical);
    }
    const store = new ProjectStore();
    await store.load();
    const project = await store.create({ name: 'Store project' });
    await store.update(project.id, { companyName: 'Saved after EXDEV' });
    const reopened = new ProjectStore();
    await reopened.load();
    expect(reopened.current()).toMatchObject({ id: project.id, companyName: 'Saved after EXDEV' });
  });

  it('keeps ordinary Windows installations on their original path', async () => {
    set('windowsStore', false);
    expect(await installBundledCli('1.0.14')).toBe(join(logical, 'bin', 'versions', '1.0.14', 'geo-publisher.exe'));
  });

  it('keeps DMG and MAS CLI paths and launcher names unchanged', async () => {
    set('platform', 'darwin'); set('arch', 'arm64');
    await writeFile(join(resources, 'cli', 'geo-publisher-darwin-arm64'), 'bundled Mac CLI');
    expect(await installBundledCli('1.0.14')).toBe(join(logical, 'bin', 'geo-publisher'));
    set('mas', true);
    const launcher = join(resources, 'integrations', 'mas-cli', 'geo-publisher');
    await mkdir(join(launcher, '..'), { recursive: true });
    await writeFile(launcher, '#!/bin/sh');
    expect(await installBundledCli('1.0.14')).toBe(launcher);
  });
});
