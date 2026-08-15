import { createHash } from 'node:crypto';
import { articleDocumentSchema, type ArticleDocument } from '../shared/article-document.js';
import { desktopDistributionRequestSchema, type DesktopDistributionRequest, type Platform } from '../shared/protocol.js';
import { ContentStore, type ContentItem } from './content-store.js';

type DistributionExecutor = {
  ensureProject(projectId?: string): string;
  fillDraft(platform: Platform, document: ArticleDocument, coverPath: string): Promise<unknown>;
  publishDraft(platform: Platform, document: ArticleDocument, coverPath: string): Promise<unknown>;
};

type DistributionStatus = 'running' | 'filled' | 'success' | 'failed' | 'action_required' | 'result_uncertain';

const coverRequiredPlatforms = new Set<Platform>(['baijia', 'toutiao', 'netease']);

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || 'DISTRIBUTION_FAILED';
}

function resultStatus(mode: 'fill' | 'publish', result: unknown): DistributionStatus {
  if (mode === 'fill') return 'filled';
  if (result && typeof result === 'object') {
    const status = (result as { status?: unknown }).status;
    if (status === 'success' || status === 'action_required' || status === 'result_uncertain') return status;
  }
  return 'result_uncertain';
}

function resultEvidence(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {};
  const value = result as Record<string, unknown>;
  return Object.fromEntries(['stage', 'message', 'url', 'screenshotPath', 'settingsScreenshotPath', 'primaryClicked', 'confirmationClicked']
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, value[key]]));
}

export class DistributionService {
  constructor(
    private readonly content: ContentStore,
    private readonly executor: DistributionExecutor,
    private readonly onRecordSaved: (record: ContentItem) => void = () => undefined,
  ) {}

  async run(rawInput: DesktopDistributionRequest): Promise<{ records: ContentItem[] }> {
    const input = desktopDistributionRequestSchema.parse(rawInput);
    this.executor.ensureProject(input.projectId);
    const article = (await this.content.list(input.projectId, 'article')).find((item) => item.id === input.articleId);
    if (!article) throw new Error('ARTICLE_NOT_FOUND: 找不到要分发的文章');
    if (article.status !== 'ready' && article.status !== 'published') throw new Error('ARTICLE_NOT_READY: 文章尚未通过质量检查');
    if (article.payload.quality && typeof article.payload.quality === 'object' && (article.payload.quality as { passed?: unknown }).passed === false) throw new Error('ARTICLE_QUALITY_REJECTED: 文章质量检查未通过');
    const document = articleDocumentSchema.parse(article.payload.document);
    if (input.platforms.includes('toutiao') && [...document.title].length > 30) throw new Error('TOUTIAO_TITLE_TOO_LONG: 头条号标题不能超过 30 个字符');
    const coverMissing = input.platforms.filter((platform) => coverRequiredPlatforms.has(platform) && !input.coverPath.trim());
    if (coverMissing.length) throw new Error(`COVER_REQUIRED: ${coverMissing.join('、')} 必须选择封面图片`);

    const contentHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
    const history = await this.content.list(input.projectId, 'distribution');
    if (input.mode === 'publish') {
      const finalized = history.find((record) => input.platforms.includes(record.platform as Platform)
        && record.payload.articleId === article.id
        && record.payload.contentHash === contentHash
        && record.payload.mode === 'publish'
        && (record.status === 'success' || record.status === 'result_uncertain'));
      if (finalized) throw new Error(`DISTRIBUTION_ALREADY_FINALIZED: ${finalized.platform} 已成功发布或结果待确认，禁止重复发布`);
    }

    const taskId = crypto.randomUUID();
    const records: ContentItem[] = [];
    for (const platform of input.platforms) {
      const startedAt = new Date().toISOString();
      let record = await this.content.save(input.projectId, {
        kind: 'distribution', title: article.title, status: 'running', platform,
        payload: { taskId, articleId: article.id, contentHash, mode: input.mode, targetPlatforms: input.platforms, startedAt },
      });
      this.onRecordSaved(record);
      try {
        const result = input.mode === 'publish'
          ? await this.executor.publishDraft(platform, document, input.coverPath)
          : await this.executor.fillDraft(platform, document, input.coverPath);
        const status = resultStatus(input.mode, result);
        record = await this.content.save(input.projectId, {
          id: record.id, kind: 'distribution', status, platform,
          payload: { ...record.payload, completedAt: new Date().toISOString(), evidence: resultEvidence(result) },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record = await this.content.save(input.projectId, {
          id: record.id, kind: 'distribution', status: 'failed', platform,
          payload: { ...record.payload, completedAt: new Date().toISOString(), error: { code: errorCode(error), message } },
        });
      }
      this.onRecordSaved(record);
      records.push(record);
    }
    if (input.mode === 'publish' && records.length > 0 && records.every((record) => record.status === 'success')) {
      const previous = article.payload.distribution && typeof article.payload.distribution === 'object'
        ? article.payload.distribution as Record<string, unknown>
        : {};
      const successfulPlatforms = [...new Set([
        ...(Array.isArray(previous.successfulPlatforms) ? previous.successfulPlatforms.filter((value): value is string => typeof value === 'string') : []),
        ...input.platforms,
      ])];
      const completedArticle = await this.content.save(input.projectId, {
        id: article.id,
        kind: 'article',
        status: 'published',
        payload: {
          ...article.payload,
          distribution: {
            ...previous,
            completedAt: new Date().toISOString(),
            lastTaskId: taskId,
            lastTargetPlatforms: input.platforms,
            successfulPlatforms,
          },
        },
      });
      this.onRecordSaved(completedArticle);
    }
    return { records };
  }
}
