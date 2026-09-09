import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_LIMIT_BYTES,
  CACHE_TARGET_BYTES,
  EVIDENCE_MAX_AGE_MS,
  maintainEvidence,
  maintainSessionCaches,
  removeStaleProjectPartitions,
} from './resource-maintenance.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'geo-resource-maintenance-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe('evidence maintenance', () => {
  it('removes expired normal evidence but retains the newest failure per platform', async () => {
    const root = await temporaryDirectory();
    const day = join(root, '2026-01-01');
    await mkdir(day);
    const normal = join(day, '1-zhihu-fill.png');
    const failure = join(day, '2-zhihu-publish-failed.png');
    await writeFile(normal, 'normal');
    await writeFile(failure, 'failure');
    const expired = new Date(Date.now() - EVIDENCE_MAX_AGE_MS - 1_000);
    await Promise.all([utimes(normal, expired, expired), utimes(failure, expired, expired)]);

    const result = await maintainEvidence(root);

    await expect(stat(normal)).rejects.toThrow();
    await expect(readFile(failure, 'utf8')).resolves.toBe('failure');
    expect(result).toEqual({ bytes: 'failure'.length, deleted: 1 });
  });

  it('caps recent evidence by deleting the oldest files first', async () => {
    const root = await temporaryDirectory();
    const day = join(root, '2026-08-30');
    await mkdir(day);
    const older = join(day, '1-zhihu-fill.png');
    const newer = join(day, '2-toutiao-fill.png');
    await writeFile(older, '1234');
    await writeFile(newer, '5678');
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(older, oldTime, oldTime);

    const result = await maintainEvidence(root, Date.now(), 4);

    expect(result).toEqual({ bytes: 4, deleted: 1 });
    await expect(stat(older)).rejects.toThrow();
    await expect(readFile(newer, 'utf8')).resolves.toBe('5678');
  });
});

describe('stale project partitions', () => {
  it('preserves registered projects and removes only old orphaned project partitions', async () => {
    const root = await temporaryDirectory();
    const partitions = join(root, 'Partitions');
    await mkdir(partitions);
    const active = '9df4ad81-d22f-4784-a1cb-43c5a3030017';
    const stale = '11111111-2222-4333-8444-555555555555';
    const activePath = join(partitions, `geo-publisher-${active}-zhihu`);
    const stalePath = join(partitions, `geo-publisher-${stale}-zhihu`);
    await Promise.all([mkdir(activePath), mkdir(stalePath)]);
    const expired = new Date(Date.now() - EVIDENCE_MAX_AGE_MS - 1_000);
    await Promise.all([utimes(activePath, expired, expired), utimes(stalePath, expired, expired)]);
    const projects = join(root, 'projects.json');
    await writeFile(projects, JSON.stringify({ currentProjectId: active, projects: [{ id: active }] }));

    await expect(removeStaleProjectPartitions(partitions, projects)).resolves.toBe(1);
    await expect(stat(activePath)).resolves.toBeDefined();
    await expect(stat(stalePath)).rejects.toThrow();
  });

  it('does nothing when the project registry is missing or malformed', async () => {
    const root = await temporaryDirectory();
    const partitions = join(root, 'Partitions');
    const stale = join(partitions, 'geo-publisher-11111111-2222-4333-8444-555555555555-zhihu');
    await mkdir(stale, { recursive: true });

    await expect(removeStaleProjectPartitions(partitions, join(root, 'missing.json'))).resolves.toBe(0);
    await expect(stat(stale)).resolves.toBeDefined();
  });
});

describe('session cache maintenance', () => {
  function cacheSession(bytes: number) {
    return {
      bytes,
      clearCacheCalls: 0,
      clearCodeCacheCalls: 0,
      async getCacheSize() { return this.bytes; },
      async clearCache() { this.clearCacheCalls += 1; this.bytes = 0; },
      async clearCodeCaches() { this.clearCodeCacheCalls += 1; },
    };
  }

  it('does not clear caches below the 1 GB soft limit', async () => {
    const first = cacheSession(CACHE_LIMIT_BYTES / 2);
    const second = cacheSession(CACHE_LIMIT_BYTES / 2);

    await expect(maintainSessionCaches([first, second])).resolves.toEqual({
      cacheBytes: CACHE_LIMIT_BYTES,
      cleared: false,
    });
    expect(first.clearCacheCalls + second.clearCacheCalls).toBe(0);
  });

  it('clears the largest idle sessions only until the cache reaches the 800 MB target', async () => {
    const largest = cacheSession(400 * 1024 * 1024);
    const middle = cacheSession(350 * 1024 * 1024);
    const smallest = cacheSession(300 * 1024 * 1024);

    await expect(maintainSessionCaches([smallest, largest, middle])).resolves.toEqual({
      cacheBytes: 650 * 1024 * 1024,
      cleared: true,
    });
    expect(largest.clearCacheCalls).toBe(1);
    expect(middle.clearCacheCalls).toBe(0);
    expect(smallest.clearCacheCalls).toBe(0);
    expect(650 * 1024 * 1024).toBeLessThanOrEqual(CACHE_TARGET_BYTES);
  });

  it('protects the platform page currently visible to the user', async () => {
    const active = cacheSession(600 * 1024 * 1024);
    const idle = cacheSession(500 * 1024 * 1024);

    await maintainSessionCaches([active, idle], active);

    expect(active.clearCacheCalls).toBe(0);
    expect(idle.clearCacheCalls).toBe(1);
  });
});
