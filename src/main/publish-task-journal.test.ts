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

  it('creates a fresh task for the same content after a confirmed result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publisher-journal-'));
    directories.push(directory);
    const store = new PublishTaskJournalStore(directory);
    const first = (await store.prepare(request())).journal;
    await store.update(first, 'success', { status: 'success' });
    const second = (await store.prepare(request())).journal;
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.state).toBe('prepared');
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('creates a fresh task when an earlier submission remains unresolved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publisher-journal-'));
    directories.push(directory);
    const store = new PublishTaskJournalStore(directory);
    const first = (await store.prepare(request())).journal;
    await store.update(first, 'dispatched');
    const second = (await store.prepare(request())).journal;
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.state).toBe('prepared');
  });

  it('prunes old completed and unresolved records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publisher-journal-'));
    directories.push(directory);
    const store = new PublishTaskJournalStore(directory);
    const completed = (await store.prepare(request())).journal;
    const unresolved = (await store.prepare({ ...request(), title: '另一篇文章' })).journal;
    await store.update(completed, 'success');
    await store.update(unresolved, 'dispatched');
    await expect(store.prune(Date.now() + 31 * 24 * 60 * 60 * 1000)).resolves.toBe(2);
    await expect(readFile(join(directory, `${completed.taskId}.json`), 'utf8')).rejects.toThrow();
    await expect(readFile(join(directory, `${unresolved.taskId}.json`), 'utf8')).rejects.toThrow();
  });

  it('replays the same operation without creating another submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publisher-journal-'));
    directories.push(directory);
    const store = new PublishTaskJournalStore(directory);
    const first = await store.prepare(request(), 'test-operation-001');
    await store.update(first.journal, 'dispatched');
    const replay = await store.prepare(request(), 'test-operation-001');
    expect(replay.replay).toBe(true);
    expect(replay.journal.taskId).toBe(first.journal.taskId);
    await expect(store.prepare({ ...request(), title: '不同文章' }, 'test-operation-001')).rejects.toThrow('OPERATION_ID_CONFLICT');
  });
});
