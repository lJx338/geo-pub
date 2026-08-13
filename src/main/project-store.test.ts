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

  it('does not silently replace an unreadable project file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geo-project-store-'));
    const path = join(directory, 'projects.json');
    await writeFile(path, '{not-json', 'utf8');
    await expect(new ProjectStore(path).load()).rejects.toThrow('PROJECT_STORE_INVALID');
  });
});
