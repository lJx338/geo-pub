import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { isWindowsStoreRuntime } from './runtime-paths.js';
import { externalDataDirectory, externalFilePath, externalSkillDirectory } from './windows-store-paths.js';

const fs = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => fs);
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalStore = Object.getOwnPropertyDescriptor(process, 'windowsStore');

function runtime(platform: string, store: boolean) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'windowsStore', { value: store, configurable: true });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GEO_PUBLISHER_USER_DATA_DIR', '/logical/GEO Publisher Desktop');
  runtime('win32', true);
  fs.stat.mockResolvedValue({ isFile: () => true });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  if (originalStore) Object.defineProperty(process, 'windowsStore', originalStore);
  else Reflect.deleteProperty(process, 'windowsStore');
  vi.unstubAllEnvs();
});

describe('MSIX external paths', () => {
  it.each([['win32', false], ['darwin', false], ['darwin', true]])('leaves %s / Store=%s untouched', async (platform, store) => {
    runtime(platform, store);
    expect(isWindowsStoreRuntime()).toBe(false);
    expect(await externalFilePath('/unchanged/geo-publisher')).toBe('/unchanged/geo-publisher');
    expect(await externalSkillDirectory('/unchanged/skill')).toBe('/unchanged/skill');
    expect(await externalDataDirectory()).toBe('/logical/GEO Publisher Desktop');
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it('resolves the Skill file instead of trusting a merged directory path', async () => {
    const physical = join('/actual-package', 'LocalCache', 'Local', 'GEO Publisher Desktop', 'integrations', 'workbuddy', 'geo-publisher');
    fs.realpath.mockResolvedValue(join(physical, 'SKILL.md'));
    expect(isWindowsStoreRuntime()).toBe(true);
    expect(await externalSkillDirectory('/logical/skill')).toBe(physical);
    expect(fs.realpath).toHaveBeenCalledWith(join('/logical/skill', 'SKILL.md'));
  });

  it('uses the resolved discovery and token files as the CLI data directory', async () => {
    const root = join('/actual-package', 'LocalCache', 'Local', 'GEO Publisher Desktop');
    fs.realpath.mockImplementation(async (path: string) => join(root, path.endsWith('discovery.json') ? 'discovery.json' : 'control-token.json'));
    expect(await externalDataDirectory()).toBe(root);
    expect(fs.realpath).toHaveBeenCalledTimes(2);
  });

  it('rejects files split between profiles instead of silently using the wrong token', async () => {
    fs.realpath.mockImplementation(async (path: string) => path.endsWith('discovery.json') ? '/store/discovery.json' : '/other/control-token.json');
    await expect(externalDataDirectory()).rejects.toThrow('不同数据目录');
  });

  it('reports missing or unreadable files without falling back to a guessed path', async () => {
    fs.stat.mockRejectedValue(new Error('access denied'));
    await expect(externalFilePath('/missing/geo-publisher.exe')).rejects.toThrow('access denied');
    fs.stat.mockResolvedValue({ isFile: () => false });
    await expect(externalFilePath('/directory')).rejects.toThrow('不是文件');
    fs.stat.mockResolvedValue({ isFile: () => true });
    fs.realpath.mockRejectedValue(new Error('cannot resolve'));
    await expect(externalFilePath('/unresolved')).rejects.toThrow('cannot resolve');
  });
});
