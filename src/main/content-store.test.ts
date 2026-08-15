import { mkdtemp, writeFile } from 'node:fs/promises';
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

  it('rejects attempts to move content between customer projects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const store = new ContentStore(directory);
    const original = await store.save(projectId, { kind: 'topic', title: '项目 A 选题', status: 'approved' });
    await expect(store.save('22222222-2222-4222-8222-222222222222', { id: original.id, kind: 'topic', title: '串项目' })).rejects.toThrow('PROJECT_CONTENT_MISMATCH');
  });

  it('reserves a topic atomically, releases failures, and keeps used topics in history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const store = new ContentStore(directory);
    const topic = await store.save(projectId, { kind: 'topic', title: '客户问题', status: 'approved' });
    await store.reserveTopic(projectId, topic.id, 'task-a');
    await expect(store.reserveTopic(projectId, topic.id, 'task-b')).rejects.toThrow('TOPIC_RESERVED');
    await store.releaseTopic(projectId, topic.id, 'task-a');
    await store.reserveTopic(projectId, topic.id, 'task-b');
    const used = await store.markTopicUsed(projectId, topic.id, 'article-a', 'task-b');
    expect(used).toMatchObject({ status: 'used', usageCount: 1, reservedBy: '' });
    expect(await store.list(projectId, 'topic', { autoSelectable: true })).toHaveLength(0);
    expect(await store.list(projectId, 'topic')).toHaveLength(1);
  });

  it('creates linked variants for evergreen subjects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const store = new ContentStore(directory);
    const parent = await store.save(projectId, { kind: 'topic', title: '长期主题', status: 'approved', reusePolicy: 'evergreen' });
    const variant = await store.createTopicVariant(projectId, parent.id, { kind: 'topic', title: '长期主题的新角度' });
    expect(variant).toMatchObject({ parentTopicId: parent.id, topicFamilyId: parent.topicFamilyId, variantNumber: 2, reusePolicy: 'evergreen' });
  });

  it('copies and deduplicates original material files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const source = join(directory, '产品资料.txt');
    await writeFile(source, '产品事实');
    const store = new ContentStore(join(directory, 'store'));
    const first = await store.importMaterial(projectId, source);
    const second = await store.importMaterial(projectId, source);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ category: 'product', status: 'active' });
  });

});
