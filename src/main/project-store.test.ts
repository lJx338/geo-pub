import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
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
});
