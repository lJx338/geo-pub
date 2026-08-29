import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVIDENCE_MAX_AGE_MS, maintainEvidence, removeStaleProjectPartitions } from './resource-maintenance.js';

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
