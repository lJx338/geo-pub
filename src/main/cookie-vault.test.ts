import { mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RendererStorageSnapshot, restorePlatformRendererStorage, snapshotPlatformCookies, snapshotPlatformRendererStorage } from './cookie-vault.js';

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
} }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let directory: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('session vault EXDEV recovery', () => {
  it('persists replacement cookie and renderer snapshots without losing logout state', async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'geo-vault-exdev-')));
    vi.stubEnv('GEO_PUBLISHER_USER_DATA_DIR', directory);
    vi.mocked(rename).mockImplementation(async (source, target) => {
      // Only the final physical staging rename is supported by this filesystem.
      if (!String(source).includes('.replace-')) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      await actualFs.rename(source, target);
    });
    const cookies = vi.fn().mockResolvedValue([{ name: 'session', value: 'secret', domain: '.zhihu.com', path: '/', secure: true }]);
    const partition = { cookies: { get: cookies } } as unknown as Session;
    const path = join(directory, 'projects', 'project', 'session-vault', 'zhihu.bin');
    await snapshotPlatformCookies(partition, 'project', 'zhihu');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject([{ name: 'session', value: 'secret' }]);
    cookies.mockResolvedValue([]);
    await snapshotPlatformCookies(partition, 'project', 'zhihu');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([]);
    const snapshots: RendererStorageSnapshot[] = [{ localStorage: { token: 'value' }, sessionStorage: {} }, { localStorage: {}, sessionStorage: {} }];
    for (const snapshot of snapshots) {
      await snapshotPlatformRendererStorage('project', 'zhihu', snapshot);
      expect(await restorePlatformRendererStorage('project', 'zhihu')).toEqual(snapshot);
    }
    expect((await actualFs.readdir(join(path, '..'))).sort()).toEqual(['zhihu.bin', 'zhihu.renderer.bin']);
  });
});
