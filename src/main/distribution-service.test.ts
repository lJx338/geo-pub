import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArticleDocument } from '../shared/article-document.js';
import type { Platform } from '../shared/protocol.js';
import { ContentStore } from './content-store.js';
import { DistributionService } from './distribution-service.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const document: ArticleDocument = {
  title: '企业如何判断内容发布流程是否稳定？',
  blocks: [{ type: 'paragraph', text: '先检查输入，再执行填充，最后核对发布结果。' }],
  tags: ['#内容发布'],
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'geo-distribution-'));
  const content = new ContentStore(directory);
  const article = await content.save(projectId, { kind: 'article', title: document.title, status: 'ready', payload: { document, quality: { passed: true } } });
  const calls: Array<{ mode: string; platform: Platform }> = [];
  const executor = {
    ensureProject: (value?: string) => { if (value !== projectId) throw new Error('PROJECT_CONTEXT_CHANGED'); return projectId; },
    fillDraft: async (platform: Platform): Promise<unknown> => { calls.push({ mode: 'fill', platform }); return { stage: 'filled', screenshotPath: `/tmp/${platform}.png` }; },
    publishDraft: async (platform: Platform): Promise<unknown> => { calls.push({ mode: 'publish', platform }); return { status: 'success', stage: 'reconciled', message: '发布成功' }; },
  };
  return { content, article, calls, executor };
}

describe('desktop distribution service', () => {
  it('fills selected platforms serially and records each result', async () => {
    const { content, article, calls, executor } = await setup();
    const saved: string[] = [];
    const service = new DistributionService(content, executor, (record) => saved.push(`${record.platform}:${record.status}`));
    const result = await service.run({ projectId, articleId: article.id, platforms: ['zhihu', 'sohu'], mode: 'fill', coverPath: '', confirmPublish: false });
    expect(calls).toEqual([{ mode: 'fill', platform: 'zhihu' }, { mode: 'fill', platform: 'sohu' }]);
    expect(result.records.map((record) => record.status)).toEqual(['filled', 'filled']);
    expect(saved).toEqual(['zhihu:running', 'zhihu:filled', 'sohu:running', 'sohu:filled']);
  });

  it('requires a cover before running platforms that need one', async () => {
    const { article, calls, executor, content } = await setup();
    const service = new DistributionService(content, executor);
    await expect(service.run({ projectId, articleId: article.id, platforms: ['baijia'], mode: 'fill', coverPath: '', confirmPublish: false })).rejects.toThrow('COVER_REQUIRED');
    expect(calls).toEqual([]);
  });

  it('continues with the next platform after one platform fails', async () => {
    const { article, calls, executor, content } = await setup();
    executor.fillDraft = async (platform: Platform): Promise<unknown> => {
      calls.push({ mode: 'fill', platform });
      if (platform === 'zhihu') throw new Error('LOGIN_REQUIRED: 请先登录');
      return { stage: 'filled' };
    };
    const result = await new DistributionService(content, executor).run({ projectId, articleId: article.id, platforms: ['zhihu', 'sohu'], mode: 'fill', coverPath: '', confirmPublish: false });
    expect(result.records.map((record) => record.status)).toEqual(['failed', 'filled']);
    expect(result.records[0]!.payload.error).toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('blocks a duplicate publish after success', async () => {
    const { article, executor, content } = await setup();
    const service = new DistributionService(content, executor);
    const first = await service.run({ projectId, articleId: article.id, platforms: ['zhihu'], mode: 'publish', coverPath: '', confirmPublish: true });
    expect(first.records[0]?.payload.targetPlatforms).toEqual(['zhihu']);
    const completed = (await content.list(projectId, 'article')).find((item) => item.id === article.id);
    expect(completed).toMatchObject({ status: 'published', payload: { distribution: { successfulPlatforms: ['zhihu'], lastTargetPlatforms: ['zhihu'] } } });
    await expect(service.run({ projectId, articleId: article.id, platforms: ['zhihu'], mode: 'publish', coverPath: '', confirmPublish: true })).rejects.toThrow('DISTRIBUTION_ALREADY_FINALIZED');
  });

  it('keeps the article available when any selected publish target fails', async () => {
    const { article, calls, executor, content } = await setup();
    executor.publishDraft = async (platform: Platform): Promise<unknown> => {
      calls.push({ mode: 'publish', platform });
      if (platform === 'zhihu') throw new Error('LOGIN_REQUIRED: 请先登录');
      return { status: 'success', stage: 'reconciled' };
    };
    const result = await new DistributionService(content, executor).run({ projectId, articleId: article.id, platforms: ['zhihu', 'sohu'], mode: 'publish', coverPath: '', confirmPublish: true });
    expect(result.records.map((record) => record.status)).toEqual(['failed', 'success']);
    const current = (await content.list(projectId, 'article')).find((item) => item.id === article.id);
    expect(current?.status).toBe('ready');
  });
});
