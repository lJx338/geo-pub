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
  it('keeps fill-only execution serial when one platform is slow', async () => {
    const { article, executor, content, calls } = await setup();
    const order: string[] = [];
    executor.fillDraft = async (platform: Platform): Promise<unknown> => {
      order.push(`${platform}:start`);
      await new Promise((resolve) => setTimeout(resolve, platform === 'zhihu' ? 45 : 5));
      order.push(`${platform}:end`);
      calls.push({ mode: 'fill', platform });
      return { stage: 'filled', networkDelayMs: platform === 'zhihu' ? 45 : 5 };
    };
    const result = await new DistributionService(content, executor).run({ projectId, articleId: article.id, platforms: ['zhihu', 'sohu'], mode: 'fill', coverPath: '', confirmPublish: false });
    expect(result.records.map((record) => record.status)).toEqual(['filled', 'filled']);
    expect(order).toEqual(['zhihu:start', 'zhihu:end', 'sohu:start', 'sohu:end']);
    expect(calls.every((call) => call.mode === 'fill')).toBe(true);
  });

  it('retries one transient fill failure without starting any publish action', async () => {
    const { article, executor, content, calls } = await setup();
    let attempts = 0;
    executor.fillDraft = async (platform: Platform): Promise<unknown> => {
      calls.push({ mode: 'fill', platform });
      if (platform === 'zhihu' && attempts++ === 0) throw new Error('NETWORK_SLOW: simulated renderer timeout');
      return { stage: 'filled' };
    };
    const result = await new DistributionService(content, executor).run({ projectId, articleId: article.id, platforms: ['zhihu', 'sohu'], mode: 'fill', coverPath: '', confirmPublish: false });
    expect(result.records.map((record) => record.status)).toEqual(['filled', 'filled']);
    expect(calls.filter((call) => call.platform === 'zhihu')).toHaveLength(2);
    expect(calls.some((call) => call.mode === 'publish')).toBe(false);
  });

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

  it('retries only the unfinished platform after a partial publish', async () => {
    const { article, executor, content, calls } = await setup();
    executor.publishDraft = async (platform: Platform): Promise<unknown> => {
      calls.push({ mode: 'publish', platform });
      return platform === 'zhihu'
        ? { status: 'success', stage: 'reconciled' }
        : { status: 'action_required', stage: 'manual' };
    };
    await new DistributionService(content, executor).run({ projectId, articleId: article.id, platforms: ['zhihu', 'sohu'], mode: 'publish', coverPath: '', confirmPublish: true });
    calls.length = 0;
    executor.publishDraft = async (platform: Platform): Promise<unknown> => { calls.push({ mode: 'publish', platform }); return { status: 'success', stage: 'reconciled' }; };
    const result = await new DistributionService(content, executor).run({ projectId, articleId: article.id, platforms: ['zhihu', 'sohu'], mode: 'publish', coverPath: '', confirmPublish: true });
    expect(calls).toEqual([{ mode: 'publish', platform: 'sohu' }]);
    expect(result.records.map((record) => record.platform)).toEqual(['sohu']);
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

  it('records a direct CLI fill and links the matching content-center article', async () => {
    const { article, executor, content } = await setup();
    const saved: string[] = [];
    const result = await new DistributionService(content, executor, (record) => saved.push(`${record.kind}:${record.status}`))
      .runDirect({ projectId, platform: 'zhihu', document, coverPath: '', mode: 'fill' });
    expect(result).toMatchObject({ stage: 'filled' });
    const [record] = await content.list(projectId, 'distribution');
    expect(record).toMatchObject({ title: document.title, platform: 'zhihu', status: 'filled' });
    expect(record?.payload).toMatchObject({ articleId: article.id, mode: 'fill', source: 'cli' });
    expect(saved).toEqual(['distribution:running', 'distribution:filled']);
  });

  it('records a direct CLI publish and marks a matching article published', async () => {
    const { article, executor, content } = await setup();
    const result = await new DistributionService(content, executor)
      .runDirect({ projectId, platform: 'zhihu', document, coverPath: '', mode: 'publish' });
    expect(result).toMatchObject({ status: 'success' });
    const [record] = await content.list(projectId, 'distribution');
    expect(record?.status).toBe('success');
    const current = (await content.list(projectId, 'article')).find((item) => item.id === article.id);
    expect(current).toMatchObject({ status: 'published', payload: { distribution: { successfulPlatforms: ['zhihu'] } } });
  });

  it('records direct CLI failures before preserving the original error', async () => {
    const { executor, content } = await setup();
    executor.fillDraft = async () => { throw new Error('LOGIN_REQUIRED: 请先登录'); };
    await expect(new DistributionService(content, executor)
      .runDirect({ projectId, platform: 'zhihu', document, coverPath: '', mode: 'fill' }))
      .rejects.toThrow('LOGIN_REQUIRED');
    const [record] = await content.list(projectId, 'distribution');
    expect(record).toMatchObject({ status: 'failed', payload: { source: 'cli', error: { code: 'LOGIN_REQUIRED' } } });
  });

  it('records an unmatched CLI document and uncertain publish result', async () => {
    const { executor, content } = await setup();
    executor.publishDraft = async () => ({ status: 'result_uncertain', stage: 'result_check' });
    const otherDocument: ArticleDocument = { ...document, title: '一篇未保存到内容中心的文章' };
    await new DistributionService(content, executor)
      .runDirect({ projectId, platform: 'sohu', document: otherDocument, coverPath: '', mode: 'publish' });
    const [record] = await content.list(projectId, 'distribution');
    expect(record?.status).toBe('result_uncertain');
    expect(record?.payload.articleId).toBeUndefined();
  });
});
