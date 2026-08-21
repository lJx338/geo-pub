import { access, mkdtemp, writeFile } from 'node:fs/promises';
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

  it('returns bounded pages with a stable cursor and total count', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const store = new ContentStore(directory);
    for (let index = 0; index < 5; index += 1) await store.save(projectId, { kind: 'topic', title: `选题 ${index}`, status: 'approved' });
    const first = await store.listPage(projectId, 'topic', {}, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);
    const second = await store.listPage(projectId, 'topic', {}, { limit: 2, beforeUpdatedAt: first.nextCursor!.updatedAt, beforeId: first.nextCursor!.id });
    expect(second.items).toHaveLength(2);
    expect(second.items.some((item) => item.id === first.items[0]?.id)).toBe(false);
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

  it('can remove evergreen reuse without losing topic history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const store = new ContentStore(directory);
    const topic = await store.save(projectId, { kind: 'topic', title: '长期主题', status: 'used', reusePolicy: 'evergreen', usageCount: 3, payload: { usageHistory: [{ articleId: 'article-a', usedAt: '2026-08-20T00:00:00.000Z' }] } });
    const updated = await store.save(projectId, { id: topic.id, kind: 'topic', reusePolicy: 'standard' });
    expect(updated).toMatchObject({ reusePolicy: 'standard', status: 'used', usageCount: 3, payload: topic.payload });
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

  it('queues image materials for one-time WorkBuddy analysis', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const source = join(directory, '设备现场.jpg');
    await writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const store = new ContentStore(join(directory, 'store'));
    const imported = await store.importMaterial(projectId, source);
    expect(imported).toMatchObject({ category: 'image', status: 'pending_analysis', payload: { mediaType: 'image', analysisStatus: 'pending', analysisVersion: 0 } });
    expect((await store.pendingImageMaterials(projectId)).map((item) => item.id)).toEqual([imported.id]);

    const analyzed = await store.analyzeImageMaterial(projectId, imported.id, {
      description: '彩钢瓦成型设备在工厂内运行的现场照片',
      category: 'equipment',
      keywords: ['彩钢瓦', '成型设备', '工厂现场'],
      uses: ['cover', 'body'],
      confidence: 'high',
      warnings: [],
    });
    expect(analyzed).toMatchObject({ category: 'equipment', status: 'active', payload: { analysisStatus: 'analyzed', analysisVersion: 1, uses: ['cover', 'body'] } });
    expect(await store.pendingImageMaterials(projectId)).toHaveLength(0);
  });

  it('rejects invalid or cross-project image analysis', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const source = join(directory, '产品.png');
    await writeFile(source, Buffer.from('png'));
    const store = new ContentStore(join(directory, 'store'));
    const imported = await store.importMaterial(projectId, source);
    await expect(store.analyzeImageMaterial(projectId, imported.id, { description: '', category: 'unknown' })).rejects.toThrow();
    await expect(store.imageMaterial('22222222-2222-4222-8222-222222222222', imported.id)).rejects.toThrow('CONTENT_NOT_FOUND');
  });

  it('deletes content within its project and removes copied material files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const source = join(directory, '待删除.png');
    await writeFile(source, Buffer.from('png'));
    const store = new ContentStore(join(directory, 'store'));
    const material = await store.importMaterial(projectId, source);
    const storedPath = String(material.payload.sourcePath);
    await store.delete(projectId, material.id);
    expect(await store.list(projectId, 'material')).toHaveLength(0);
    await expect(access(storedPath)).rejects.toThrow();
    await expect(store.delete('22222222-2222-4222-8222-222222222222', material.id)).rejects.toThrow('CONTENT_NOT_FOUND');
  });

  it('keeps distribution audit records and active topic reservations protected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const store = new ContentStore(directory);
    const distribution = await store.save(projectId, { kind: 'distribution', title: '发布记录' });
    const topic = await store.save(projectId, { kind: 'topic', title: '正在使用', status: 'approved' });
    await store.reserveTopic(projectId, topic.id, 'task-a');
    await expect(store.delete(projectId, distribution.id)).rejects.toThrow('CONTENT_DELETE_FORBIDDEN');
    await expect(store.delete(projectId, topic.id)).rejects.toThrow('TOPIC_RESERVED');
  });

  it('deletes every content kind and copied file when its customer project is deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const source = join(directory, '项目素材.png');
    await writeFile(source, Buffer.from('png'));
    const root = join(directory, 'store');
    const store = new ContentStore(root);
    await store.importMaterial(projectId, source);
    await store.save(projectId, { kind: 'topic', title: '选题' });
    await store.save(projectId, { kind: 'article', title: '文章' });
    await store.save(projectId, { kind: 'distribution', title: '分发记录' });

    await store.deleteProject(projectId);

    expect(await store.list(projectId)).toHaveLength(0);
    await expect(access(join(root, projectId))).rejects.toThrow();
  });

  it('resolves a referenced material only for execution and prevents deleting it while an article uses it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-content-store-'));
    const source = join(directory, '正文图片.png');
    await writeFile(source, Buffer.from('png'));
    const store = new ContentStore(join(directory, 'store'));
    const material = await store.importMaterial(projectId, source);
    await store.save(projectId, {
      kind: 'article',
      title: '含图文章',
      payload: { document: { title: '含图文章', blocks: [{ type: 'image', materialId: material.id, alt: '图片' }] } },
    });

    const resolved = await store.resolveArticleImages(projectId, { title: '含图文章', tags: [], blocks: [{ type: 'image', materialId: material.id, alt: '图片' }] });
    expect(resolved.blocks[0]).toMatchObject({ type: 'image', materialId: material.id, src: 'data:image/png;base64,cG5n' });
    await expect(store.delete(projectId, material.id)).rejects.toThrow('MATERIAL_IN_USE');
  });

});
