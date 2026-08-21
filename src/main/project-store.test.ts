import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ProjectStore } from './project-store.js';

describe('project store', () => {
  it('creates a current project and keeps its company profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const store = new ProjectStore(join(directory, 'projects.json'));
    await store.load();
    const project = await store.create({ name: '测试客户', companyName: '测试公司', industry: '企业服务' });
    expect(store.current()).toMatchObject({ id: project.id, companyName: '测试公司' });
    expect(project.publishingDefaults.baijia.declarations).toEqual(['aiGenerated']);
  });

  it('stores platform defaults per customer project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const store = new ProjectStore(join(directory, 'projects.json'));
    await store.load();
    const project = await store.create({ name: '百家号客户' });
    const updated = await store.update(project.id, { publishingDefaults: { baijia: { smartCreation: ['autoPodcast'], declarations: [], sourceDate: '', sourceLocation: '' } } });
    expect(updated.publishingDefaults.baijia).toMatchObject({ smartCreation: ['autoPodcast'], declarations: [] });
  });

  it('accepts a complete long-form company profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const store = new ProjectStore(join(directory, 'projects.json'));
    await store.load();
    const industry = '体育场馆运营、青少年培训和赛事服务。'.repeat(40);
    const project = await store.create({ name: '完整资料客户', industry, products: '产品与服务说明。'.repeat(100) });
    expect(project.industry).toBe(industry);
  });

  it('discards website and contact details from project input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const store = new ProjectStore(join(directory, 'projects.json'));
    await store.load();
    const project = await store.create({
      name: '无导流信息客户',
      website: 'https://example.com',
      contact: '13800000000',
    } as Parameters<ProjectStore['create']>[0] & { website: string; contact: string });
    expect(project).not.toHaveProperty('website');
    expect(project).not.toHaveProperty('contact');
  });

  it('switches projects without merging customer profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const store = new ProjectStore(join(directory, 'projects.json'));
    await store.load();
    const first = await store.create({ name: '客户 A', companyName: '公司 A' });
    const second = await store.create({ name: '客户 B', companyName: '公司 B' });
    await store.select(second.id);
    await store.update(first.id, { industry: '工业服务' });
    expect(store.current()).toMatchObject({ id: second.id, companyName: '公司 B' });
    expect(store.get(first.id)).toMatchObject({ companyName: '公司 A', industry: '工业服务' });
  });

  it('selects every newly created project as the current project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const store = new ProjectStore(join(directory, 'projects.json'));
    await store.load();
    await store.create({ name: '客户 A' });
    const second = await store.create({ name: '客户 B' });
    expect(store.current()).toMatchObject({ id: second.id, name: '客户 B' });
  });

  it('does not silently replace an unreadable project file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const path = join(directory, 'projects.json');
    await writeFile(path, '{not-json', 'utf8');
    await expect(new ProjectStore(path).load()).rejects.toThrow('PROJECT_STORE_INVALID');
  });

  it('exports profile only and imports it into a fresh isolated project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const store = new ProjectStore(join(directory, 'projects.json'));
    await store.load();
    const original = await store.create({ name: '客户 A', companyName: '公司 A', serviceArea: '华南地区' });
    const imported = await store.import(store.export(original.id));
    expect(imported).toMatchObject({ name: '客户 A', companyName: '公司 A', serviceArea: '华南地区' });
    expect(imported.id).not.toBe(original.id);
    await store.archive(original.id);
    expect(store.list().map((project) => project.id)).toEqual([imported.id]);
  });
});
