import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../content-store.js';
import { DistributionService } from '../distribution-service.js';
import { PlatformSessions } from '../platform-sessions.js';
import { controlRequestSchema, desktopDistributionRequestSchema } from '../../shared/protocol.js';
import { buildDistributionDiagnosis } from '../../shared/distribution-diagnostics.js';
import type { ArticleDocument } from '../../shared/article-document.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const document: ArticleDocument = { title: '微信公众号集成验证', tags: [], blocks: [{ type: 'paragraph', text: '通过原分发流程存入草稿箱。' }] };
const result = { platform: 'wechat', status: 'filled', stage: 'draft_verified', saved: true, verified: true, mediaId: 'draft-1', operationKey: 'a'.repeat(64), message: '已保存并读回核对' };

async function setup(response: unknown = result) {
  const root = await mkdtemp(join(tmpdir(), 'geo-wechat-distribution-'));
  const content = new ContentStore(join(root, 'content'));
  const article = await content.save(projectId, { kind: 'article', title: document.title, status: 'ready', payload: { document } });
  const executor = { ensureProject: () => projectId, fillDraft: vi.fn(async () => response), publishDraft: vi.fn(async () => ({ status: 'success' })) };
  const service = new DistributionService(content, executor);
  const input = { projectId, articleId: article.id, platforms: ['wechat'] as ['wechat'], mode: 'fill' as const, coverPath: '/fixture/cover.png' };
  return { content, article, executor, service, input };
}

describe('WeChat in the original distribution flow', () => {
  it('records a verified draft in the original history without marking the article published', async () => {
    const { service, input, content, executor } = await setup();
    const { records } = await service.run(input);
    expect(records[0]).toMatchObject({ platform: 'wechat', status: 'filled', payload: { articleId: input.articleId, mode: 'fill', evidence: { mediaId: 'draft-1', operationKey: result.operationKey, saved: true, verified: true } } });
    expect((await content.list(projectId, 'distribution'))).toHaveLength(1);
    expect((await content.list(projectId, 'article'))[0]!.status).toBe('ready');
    expect(executor.publishDraft).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...result, status: 'action_required', verified: false }, 'action_required'],
    [{ status: 'result_uncertain', saved: false, verified: false, operationKey: result.operationKey }, 'result_uncertain'],
    [{ status: 'filled', verified: false }, 'result_uncertain'],
    [undefined, 'result_uncertain'],
  ])('does not turn an unverified API response into filled', async (response, expected) => {
    const { service, input, executor } = await setup(null);
    executor.fillDraft.mockResolvedValue(response);
    expect((await service.run(input)).records[0]!.status).toBe(expected);
    expect(executor.fillDraft).toHaveBeenCalledTimes(1);
  });

  it('does not retry WeChat when the browser retry policy matches an error', async () => {
    const { service, input, executor } = await setup();
    executor.fillDraft.mockRejectedValue(new Error('TIMEOUT: interrupted'));
    expect((await service.run(input)).records[0]!.status).toBe('failed');
    expect(executor.fillDraft).toHaveBeenCalledTimes(1);
  });

  it('supports WeChat-only titles/options and fails before any platform runs if title/cover are invalid', async () => {
    const { service, input, executor, content, article } = await setup();
    await content.save(projectId, { id: article.id, kind: 'article', payload: { document: { ...document, title: '较长的原文章标题'.repeat(6) } } });
    await expect(service.run(input)).rejects.toThrow('WECHAT_TITLE_TOO_LONG');
    await expect(service.run({ ...input, coverPath: '', platformOptions: { wechat: { title: '公众号短标题' } } })).rejects.toThrow('COVER_REQUIRED');
    expect(executor.fillDraft).not.toHaveBeenCalled();
    const options = { title: '公众号短标题', author: '测试作者', expectedAppId: 'wx1234567890abcdef' };
    const outcome = await service.run({ ...input, platformOptions: { wechat: options } });
    expect(outcome.records[0]!.title).toBe('公众号短标题');
    expect(executor.fillDraft.mock.calls[0]).toEqual(['wechat', expect.anything(), input.coverPath, expect.objectContaining({ wechat: options })]);
  });

  it('rejects WeChat publication through the desktop and direct routes before side effects', async () => {
    const { service, input, executor, content } = await setup();
    await expect(service.run({ ...input, platforms: ['baijia', 'wechat'], mode: 'publish', confirmPublish: true })).rejects.toThrow('微信公众号目前仅支持保存草稿');
    await expect(service.runDirect({ projectId, platform: 'wechat', document, coverPath: '', mode: 'publish' })).rejects.toThrow('WECHAT_DRAFT_ONLY');
    expect(executor.fillDraft).not.toHaveBeenCalled(); expect(executor.publishDraft).not.toHaveBeenCalled();
    expect(await content.list(projectId, 'distribution')).toHaveLength(0);
  });

  it('accepts draft API commands and rejects publish API commands', () => {
    const base = { id: 'one', token: 't'.repeat(32), projectId, platform: 'wechat', document, coverPath: '/cover.png' };
    expect(controlRequestSchema.safeParse({ ...base, action: 'draft.fill' }).success).toBe(true);
    expect(controlRequestSchema.safeParse({ ...base, action: 'draft.publish', confirmPublish: true }).success).toBe(false);
    expect(desktopDistributionRequestSchema.safeParse({ projectId, articleId: 'one', platforms: ['wechat'], mode: 'fill' }).success).toBe(true);
  });

  it('rechecks the current customer after asynchronous article reads on the direct route', async () => {
    const { service, content, executor } = await setup();
    let switched = false;
    executor.ensureProject = () => { if (switched) throw new Error('PROJECT_CONTEXT_CHANGED: 客户已切换'); return projectId; };
    vi.spyOn(content, 'resolveArticleImages').mockImplementation(async () => { switched = true; return document; });
    await expect(service.runDirect({ projectId, platform: 'wechat', document, coverPath: '/cover.png', mode: 'fill' })).rejects.toThrow('PROJECT_CONTEXT_CHANGED');
    expect(executor.fillDraft).not.toHaveBeenCalled();
  });

  it('shows draft-specific guidance for success and uncertainty', () => {
    const success = buildDistributionDiagnosis({ platform: 'wechat', status: 'filled', payload: { mode: 'fill', evidence: result } });
    expect(success.title).toBe('微信公众号草稿已保存'); expect(success.nextAction).toContain('后台手动');
    const uncertain = buildDistributionDiagnosis({ platform: 'wechat', status: 'result_uncertain' });
    expect(uncertain.nextAction).toContain('不要重复创建'); expect(uncertain.retry).not.toContain('再次点击发布');
  });
});

describe('WeChat in the original project/task lock', () => {
  it('keeps the project locked while the API runs and never opens a browser editor', async () => {
    let finish!: (value: unknown) => void;
    const fillDraft = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const changed = vi.fn();
    const sessions = Object.assign(Object.create(PlatformSessions.prototype), {
      projectId, pendingOperations: 0, operationTail: Promise.resolve(), onBusyChanged: changed,
      wechat: { fillDraft },
    }) as PlatformSessions;
    const task = sessions.fillDraft('wechat', document, '/cover.png', { wechat: { title: '临时短标题', author: '作者', expectedAppId: 'wx1234567890abcdef' } });
    await Promise.resolve(); await Promise.resolve();
    expect(sessions.isBusy()).toBe(true);
    await expect(sessions.selectProject('22222222-2222-4222-8222-222222222222')).rejects.toThrow('PUBLISHER_BUSY');
    await expect(sessions.open('baijia')).rejects.toThrow('PUBLISHER_BUSY');
    expect(fillDraft).toHaveBeenCalledWith({ projectId, expectedAppId: 'wx1234567890abcdef', document: { ...document, title: '临时短标题' }, coverPath: '/cover.png', options: { author: '作者' } });
    finish(result); expect(await task).toEqual(result); expect(sessions.isBusy()).toBe(false);
    await expect(sessions.publishDraft('wechat', document, '/cover.png')).rejects.toThrow('WECHAT_DRAFT_ONLY');
    expect(fillDraft).toHaveBeenCalledTimes(1);
  });
});
