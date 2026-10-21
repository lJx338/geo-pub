import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBundledCli } from './cli-installer.js';

const electron = vi.hoisted(() => ({ app: { isPackaged: true, getAppPath: vi.fn() } }));
vi.mock('electron', () => electron);
const properties = ['platform', 'arch', 'windowsStore', 'mas', 'resourcesPath'] as const;
const descriptors = properties.map(name => [name, Object.getOwnPropertyDescriptor(process, name)] as const);
let temporary: string, logical: string, physical: string, resources: string;
function set(name: string, value: unknown) { Object.defineProperty(process, name, { value, configurable: true }); }

beforeEach(async () => {
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
