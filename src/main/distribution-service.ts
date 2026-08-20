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

type DirectDistributionRequest = {
  projectId: string;
  platform: Platform;
  document: ArticleDocument;
  coverPath: string;
  mode: 'fill' | 'publish';
};

const coverRequiredPlatforms = new Set<Platform>(['baijia', 'toutiao', 'netease']);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryableFillError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /NETWORK_SLOW|TIMEOUT|EVIDENCE_CAPTURE_TIMEOUT|NETEASE_(?:CLEAR|TEXT_RESET|TEXT_FILL)_FAILED|Execution context was destroyed|Render frame was disposed|frame was detached|ERR_ABORTED|target closed/i.test(message);
}

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

function documentHash(document: ArticleDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

export class DistributionService {
  constructor(
    private readonly content: ContentStore,
    private readonly executor: DistributionExecutor,
    private readonly onRecordSaved: (record: ContentItem, source: 'desktop' | 'cli') => void = () => undefined,
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
    const contentHash = documentHash(document);
    const history = await this.content.list(input.projectId, 'distribution');
    const finalizedPlatforms = new Set<Platform>();
    if (input.mode === 'publish') {
      for (const record of history) {
        if (input.platforms.includes(record.platform as Platform)
        && record.payload.articleId === article.id
        && record.payload.contentHash === contentHash
        && record.payload.mode === 'publish'
        && (record.status === 'success' || record.status === 'result_uncertain')) {
          finalizedPlatforms.add(record.platform as Platform);
        }
      }
      if (finalizedPlatforms.size === input.platforms.length) {
        const platform = [...finalizedPlatforms][0];
        throw new Error(`DISTRIBUTION_ALREADY_FINALIZED: ${platform} 已成功发布或结果待确认，禁止重复发布`);
      }
    }

    const targetPlatforms = input.platforms.filter((platform) => !finalizedPlatforms.has(platform));
    const coverMissing = targetPlatforms.filter((platform) => coverRequiredPlatforms.has(platform) && !input.coverPath.trim());
    if (coverMissing.length) throw new Error(`COVER_REQUIRED: ${coverMissing.join('、')} 必须选择封面图片`);

    const taskId = crypto.randomUUID();
    const records: ContentItem[] = [];
    for (const platform of targetPlatforms) {
      const startedAt = new Date().toISOString();
      let record = await this.content.save(input.projectId, {
        kind: 'distribution', title: article.title, status: 'running', platform,
        payload: { taskId, articleId: article.id, contentHash, mode: input.mode, source: 'desktop', targetPlatforms, startedAt },
      });
      this.onRecordSaved(record, 'desktop');
      try {
        let result: unknown;
        if (input.mode === 'publish') {
          result = await this.executor.publishDraft(platform, document, input.coverPath);
        } else {
          try {
            result = await this.executor.fillDraft(platform, document, input.coverPath);
          } catch (error) {
            if (!isRetryableFillError(error)) throw error;
            await delay(1_000);
            result = await this.executor.fillDraft(platform, document, input.coverPath);
          }
        }
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
      this.onRecordSaved(record, 'desktop');
      records.push(record);
    }
    if (input.mode === 'publish' && records.length > 0 && records.every((record) => record.status === 'success')) {
      const previous = article.payload.distribution && typeof article.payload.distribution === 'object'
        ? article.payload.distribution as Record<string, unknown>
        : {};
      const successfulPlatforms = [...new Set([
        ...(Array.isArray(previous.successfulPlatforms) ? previous.successfulPlatforms.filter((value): value is string => typeof value === 'string') : []),
        ...targetPlatforms,
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
            lastTargetPlatforms: targetPlatforms,
            successfulPlatforms,
          },
        },
      });
      this.onRecordSaved(completedArticle, 'desktop');
    }
    return { records };
  }

  /** Records WorkBuddy/production CLI actions without changing their response contract. */
  async runDirect(rawInput: DirectDistributionRequest): Promise<unknown> {
    const document = articleDocumentSchema.parse(rawInput.document);
    this.executor.ensureProject(rawInput.projectId);
    const contentHash = documentHash(document);
    const articles = await this.content.list(rawInput.projectId, 'article');
    const hashMatches = articles.filter((item) => {
      try {
        return documentHash(articleDocumentSchema.parse(item.payload.document)) === contentHash;
      } catch {
        return false;
      }
    });
    const titleMatches = articles.filter((item) => item.title === document.title);
    const article = hashMatches.length === 1 ? hashMatches[0] : titleMatches.length === 1 ? titleMatches[0] : undefined;
    const taskId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let record = await this.content.save(rawInput.projectId, {
      kind: 'distribution',
      title: document.title,
      status: 'running',
      platform: rawInput.platform,
      payload: {
        taskId,
        ...(article ? { articleId: article.id } : {}),
        contentHash,
        mode: rawInput.mode,
        source: 'cli',
        targetPlatforms: [rawInput.platform],
        startedAt,
      },
    });
    this.onRecordSaved(record, 'cli');

    try {
      const result = rawInput.mode === 'publish'
        ? await this.executor.publishDraft(rawInput.platform, document, rawInput.coverPath)
        : await this.executor.fillDraft(rawInput.platform, document, rawInput.coverPath);
      const status = resultStatus(rawInput.mode, result);
      record = await this.content.save(rawInput.projectId, {
        id: record.id,
        kind: 'distribution',
        status,
        platform: rawInput.platform,
        payload: { ...record.payload, completedAt: new Date().toISOString(), evidence: resultEvidence(result) },
      });
      this.onRecordSaved(record, 'cli');
      if (article && rawInput.mode === 'publish' && status === 'success') {
        await this.markArticlePublished(rawInput.projectId, article, taskId, [rawInput.platform], 'cli');
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = await this.content.save(rawInput.projectId, {
        id: record.id,
        kind: 'distribution',
        status: 'failed',
        platform: rawInput.platform,
        payload: { ...record.payload, completedAt: new Date().toISOString(), error: { code: errorCode(error), message } },
      });
      this.onRecordSaved(record, 'cli');
      throw error;
    }
  }

  private async markArticlePublished(projectId: string, article: ContentItem, taskId: string, platforms: Platform[], source: 'desktop' | 'cli'): Promise<void> {
    const previous = article.payload.distribution && typeof article.payload.distribution === 'object'
      ? article.payload.distribution as Record<string, unknown>
      : {};
    const successfulPlatforms = [...new Set([
      ...(Array.isArray(previous.successfulPlatforms) ? previous.successfulPlatforms.filter((value): value is string => typeof value === 'string') : []),
      ...platforms,
    ])];
    const completedArticle = await this.content.save(projectId, {
      id: article.id,
      kind: 'article',
      status: 'published',
      payload: {
        ...article.payload,
        distribution: {
          ...previous,
          completedAt: new Date().toISOString(),
          lastTaskId: taskId,
          lastTargetPlatforms: platforms,
          successfulPlatforms,
        },
      },
    });
    this.onRecordSaved(completedArticle, source);
  }
}
