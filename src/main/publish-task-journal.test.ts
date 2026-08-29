import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PublishTaskJournalStore, publishContentHash } from './publish-task-journal.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

function request() {
  return { platform: 'zhihu' as const, title: '稳定性测试', html: '<p>正文</p>', coverPath: '', tags: ['自动化', '测试'] };
}

describe('publish task journal', () => {
  it('uses a stable content hash regardless of tag order', () => {
    expect(publishContentHash(request())).toBe(publishContentHash({ ...request(), tags: ['测试', '自动化'] }));
  });

  it('reuses a confirmed result for the same content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publisher-journal-'));
    directories.push(directory);
    const store = new PublishTaskJournalStore(directory);
    const first = await store.prepare(request());
    await store.update(first, 'success', { status: 'success' });
    const second = await store.prepare(request());
    expect(second.taskId).toBe(first.taskId);
    expect(second.state).toBe('success');
  });

  it('rejects repeat publication while a submitted task remains unresolved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publisher-journal-'));
    directories.push(directory);
    const store = new PublishTaskJournalStore(directory);
    const first = await store.prepare(request());
    await store.update(first, 'dispatched');
    await expect(store.prepare(request())).rejects.toThrow('RESULT_UNCERTAIN');
  });

  it('prunes old completed records but preserves unresolved publish attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publisher-journal-'));
    directories.push(directory);
    const store = new PublishTaskJournalStore(directory);
    const completed = await store.prepare(request());
    const unresolved = await store.prepare({ ...request(), title: '另一篇文章' });
    await store.update(completed, 'success');
    await store.update(unresolved, 'dispatched');
    await expect(store.prune(Date.now() + 31 * 24 * 60 * 60 * 1000)).resolves.toBe(1);
    await expect(readFile(join(directory, `${completed.taskId}.json`), 'utf8')).rejects.toThrow();
    await expect(readFile(join(directory, `${unresolved.taskId}.json`), 'utf8')).resolves.toContain('dispatched');
  });
});
