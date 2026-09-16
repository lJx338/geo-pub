import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PublishTaskHistoryStore, taskStatusForResult } from './publish-task-history.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe('publish task history', () => {
  it('persists user-facing progress without article content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publish-history-'));
    directories.push(directory);
    const store = new PublishTaskHistoryStore(directory);
    const task = await store.start({ platform: 'toutiao', action: 'fill', phase: 'opening', title: '一篇文章' });
    const updated = await store.update(task, { phase: 'filling', status: 'success', finishedAt: new Date().toISOString() });
    await expect(store.list()).resolves.toEqual([updated]);
    expect(JSON.stringify(updated)).not.toContain('html');
  });

  it('maps uncertain and actionable results to visible task states', () => {
    expect(taskStatusForResult({ status: 'result_uncertain' })).toBe('result_uncertain');
    expect(taskStatusForResult({ status: 'action_required' })).toBe('action_required');
    expect(taskStatusForResult({ status: 'success' })).toBe('success');
  });

  it('removes legacy open-page records during migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publish-history-'));
    directories.push(directory);
    const store = new PublishTaskHistoryStore(directory);
    await store.start({ platform: 'baijia', action: 'open', phase: 'opening' });
    const fill = await store.start({ platform: 'baijia', action: 'fill', phase: 'opening', title: '正式文章' });
    await store.update(fill, { status: 'success', finishedAt: new Date().toISOString() });
    await expect(store.removeByAction(['open', 'inspect'])).resolves.toBe(1);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it('runs the legacy action migration only once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publish-history-'));
    directories.push(directory);
    const store = new PublishTaskHistoryStore(directory);
    await store.start({ platform: 'baijia', action: 'open', phase: 'opening' });
    await expect(store.migrateLegacyActions()).resolves.toBe(1);
    await store.start({ platform: 'toutiao', action: 'open', phase: 'opening' });
    await expect(store.migrateLegacyActions()).resolves.toBe(0);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it('loads only the requested number of recent records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publish-history-'));
    directories.push(directory);
    const store = new PublishTaskHistoryStore(directory);
    for (let index = 0; index < 25; index += 1) {
      await store.start({ platform: 'zhihu', action: 'fill', phase: 'opening', title: `文章 ${index}` });
    }
    await expect(store.list(20)).resolves.toHaveLength(20);
  });

  it('marks interrupted publishes uncertain and interrupted fills failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-publish-history-'));
    directories.push(directory);
    const store = new PublishTaskHistoryStore(directory);
    const publish = await store.start({ platform: 'zhihu', action: 'publish', phase: 'dispatching', title: '待确认发布' });
    const fill = await store.start({ platform: 'zhihu', action: 'fill', phase: 'filling', title: '待重试填充' });

    await expect(store.recoverInterrupted(Date.parse('2026-09-09T12:00:00.000Z'))).resolves.toBe(2);
    await expect(store.get(publish.taskId)).resolves.toMatchObject({
      status: 'result_uncertain',
      errorCode: 'WORKER_INTERRUPTED',
      finishedAt: '2026-09-09T12:00:00.000Z',
    });
    await expect(store.get(fill.taskId)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'WORKER_INTERRUPTED',
      finishedAt: '2026-09-09T12:00:00.000Z',
    });
  });
});
