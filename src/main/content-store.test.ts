import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContentStore } from './content-store.js';

const projectId = '11111111-1111-4111-8111-111111111111';

describe('content store', () => {
  it('keeps content isolated by customer project and supports kind filtering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const store = new ContentStore(directory);
    await store.save(projectId, { kind: 'article', title: '项目 A 文章' });
    await store.save('22222222-2222-4222-8222-222222222222', { kind: 'topic', title: '项目 B 选题' });
    expect((await store.list(projectId)).map((item) => item.title)).toEqual(['项目 A 文章']);
    expect((await store.list(projectId, 'article')).map((item) => item.kind)).toEqual(['article']);
  });

  it('updates an existing article without changing its project identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const store = new ContentStore(directory);
    const original = await store.save(projectId, { kind: 'article', title: '初稿', status: 'draft' });
    const updated = await store.save(projectId, { id: original.id, kind: 'article', title: '终稿', status: 'ready' });
    expect(updated).toMatchObject({ id: original.id, projectId, title: '终稿', status: 'ready' });
    expect(await store.list(projectId)).toHaveLength(1);
  });
});
