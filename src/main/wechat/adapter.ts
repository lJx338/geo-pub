import { createHash } from 'node:crypto';
import { WechatApiClient } from './api.js';
import { loadBodyImages, makeWechatArticle, prepareDocument, readLocalImage, verifyWechatDraft, type WechatMaterialResolver } from './document.js';
import { WechatError, safeWechatError } from './errors.js';
import { requireWechatProjectId, WechatStore, type WechatOperation } from './storage.js';
import { WECHAT_BACKEND_URL, type WechatCredentials, type WechatDraftInput, type WechatDraftResult } from './types.js';

export interface WechatAdapterDependencies {
  store: WechatStore;
  resolveMaterial?: WechatMaterialResolver;
  createClient?: (credentials: WechatCredentials) => WechatApiClient;
}

/** Local official-API adapter. No browser cookies, publication or mass-message APIs. */
export class WechatAdapter {
  private readonly clients = new Map<string, { fingerprint: string; client: WechatApiClient }>();
  constructor(private readonly dependencies: WechatAdapterDependencies) {}

  async connectionSettings(projectId: string) {
    const credentials = await this.dependencies.store.readCredentials(projectId);
    // AppSecret is never returned to a renderer or included in task records.
    return { configured: !!credentials, appId: credentials?.appId ?? '' };
  }

  async saveCredentials(projectId: string, credentials: WechatCredentials): Promise<void> {
    const id = requireWechatProjectId(projectId);
    await this.dependencies.store.exclusive(id, async () => {
      await this.dependencies.store.saveCredentials(id, credentials);
      this.clients.delete(id);
    });
  }

  async clearCredentials(projectId: string): Promise<void> {
    const id = requireWechatProjectId(projectId);
    await this.dependencies.store.exclusive(id, async () => {
      await this.dependencies.store.clearCredentials(id);
      this.clients.delete(id);
    });
  }

  private async connection(projectId: string) {
    const credentials = await this.dependencies.store.readCredentials(projectId);
    if (!credentials) throw new WechatError('WECHAT_NOT_CONFIGURED', '请先填写此客户项目的公众号连接信息');
    const fingerprint = createHash('sha256').update(JSON.stringify(credentials)).digest('hex');
    let entry = this.clients.get(projectId);
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, client: this.dependencies.createClient?.(credentials) ?? new WechatApiClient(credentials) };
      this.clients.set(projectId, entry);
    }
    return { appId: credentials.appId, api: entry.client };
  }

  async testConnection(projectId: string) {
    const id = requireWechatProjectId(projectId);
    return this.dependencies.store.exclusive(id, async () => (await this.connection(id)).api.testConnection());
  }

  async history(projectId: string) {
    return (await this.dependencies.store.listOperations(projectId)).map((record) => ({
      ...this.result(record, true), appId: record.appId, updatedAt: record.updatedAt,
    }));
  }

  async fillDraft(input: WechatDraftInput): Promise<WechatDraftResult> {
    const projectId = requireWechatProjectId(input.projectId);
    return this.dependencies.store.exclusive(projectId, async () => {
      const { appId, api } = await this.connection(projectId);
      if (input.expectedAppId !== undefined && input.expectedAppId !== appId) {
        throw new WechatError('WECHAT_ACCOUNT_CHANGED', '页面显示的 AppID 与已保存的连接不一致，请先保存连接信息');
      }
      const { document, options } = prepareDocument(input.document, input.options);
      // Finish all local validation before any remote material or draft write.
      const cover = await readLocalImage(input.coverPath, true);
      const images = await loadBodyImages(projectId, document, this.dependencies.resolveMaterial);
      const imageHashes = [...images].map(([index, image]) => [index, createHash('sha256').update(image.bytes).digest('hex')]);
      const identityDocument = { ...document, blocks: document.blocks.map((block) => block.type === 'image'
        ? { type: block.type, alt: block.alt ?? '', caption: block.caption ?? '' } : block) };
      const key = createHash('sha256').update(JSON.stringify({ version: 1, projectId, appId, document: identityDocument, options,
        cover: createHash('sha256').update(cover.bytes).digest('hex'), images: imageHashes })).digest('hex');
      const existing = await this.dependencies.store.readOperation(projectId, key);
      if (existing && existing.appId !== appId) throw new WechatError('WECHAT_RECORD_INVALID', '草稿记录中的公众号与当前连接不一致');
      if (existing?.mediaId) return this.verify(existing, api, true);
      if (existing && ['submitting', 'uncertain', 'created', 'verified'].includes(existing.state)) return this.result(existing, true);

      const now = new Date().toISOString();
      let record: WechatOperation = { version: 1, projectId, key, appId, title: document.title, state: 'prepared', createdAt: existing?.createdAt ?? now, updatedAt: now };
      await this.dependencies.store.saveOperation(record);
      try {
        const coverId = await api.uploadCover(cover);
        const urls = new Map<number, string>();
        const uploaded = new Map<string, string>();
        for (const [index, image] of images) {
          const hash = createHash('sha256').update(image.bytes).digest('hex');
          let url = uploaded.get(hash);
          if (!url) { url = await api.uploadBodyImage(image); uploaded.set(hash, url); }
          urls.set(index, url);
        }
        record.article = makeWechatArticle(document, options, coverId, urls);
      } catch (error) {
        // A failed upload cannot have created an article. A later retry is allowed.
        const safe = safeWechatError(error);
        record = { ...record, state: 'failed', errorCode: safe.code, message: safe.message, updatedAt: new Date().toISOString() };
        await this.dependencies.store.saveOperation(record);
        return this.result(record, false);
      }

      // Persist intent BEFORE draft/add. A crash here must not produce a second draft.
      record.state = 'submitting';
      record.updatedAt = new Date().toISOString();
      await this.dependencies.store.saveOperation(record);
      try {
        record.mediaId = await api.createDraft(record.article!);
        record.state = 'created';
      } catch (error) {
        const safe = safeWechatError(error);
        record.state = safe.uncertain || !(error instanceof WechatError) ? 'uncertain' : 'failed';
        record.errorCode = safe.code;
        record.message = safe.message;
      }
      record.updatedAt = new Date().toISOString();
      try { await this.dependencies.store.saveOperation(record); }
      catch {
        // The durable record is still 'submitting'; it will block another creation.
        return this.result({ ...record, state: 'uncertain', errorCode: 'WECHAT_RECORD_WRITE_FAILED',
          message: '微信请求已发送，但本地记录未能保存，请先在公众号后台核对' }, false);
      }
      return record.mediaId ? this.verify(record, api, false) : this.result(record, false);
    });
  }

  /** Read back a known draft without uploading materials or creating another draft. */
  async recheckDraft(projectId: string, operationKey: string): Promise<WechatDraftResult> {
    const id = requireWechatProjectId(projectId);
    return this.dependencies.store.exclusive(id, async () => {
      const { appId, api } = await this.connection(id);
      const record = await this.dependencies.store.readOperation(id, operationKey);
      if (!record) throw new WechatError('WECHAT_RECORD_NOT_FOUND', '找不到这条草稿记录');
      if (record.appId !== appId) throw new WechatError('WECHAT_ACCOUNT_CHANGED', '这条记录属于另一个公众号，请先恢复对应的连接设置');
      return record.mediaId ? this.verify(record, api, true) : this.result(record, true);
    });
  }

  private async verify(record: WechatOperation, api: WechatApiClient, reused: boolean): Promise<WechatDraftResult> {
    try {
      if (!record.article || !record.mediaId) throw new WechatError('WECHAT_RECORD_INVALID', '本地草稿记录缺少核对信息');
      verifyWechatDraft(record.article, await api.getDraft(record.mediaId));
      record.state = 'verified';
      delete record.errorCode;
      record.message = '已保存到微信公众号草稿箱，并已读回核对';
    } catch (error) {
      const safe = safeWechatError(error);
      record.state = 'created';
      record.errorCode = safe.code;
      record.message = `草稿已创建，读回核对未通过。${safe.message}`;
    }
    record.updatedAt = new Date().toISOString();
    try { await this.dependencies.store.saveOperation(record); }
    catch { return this.result({ ...record, state: 'created', errorCode: 'WECHAT_RECORD_WRITE_FAILED', message: '草稿已创建，但核对结果未能写入本地记录，请稍后重新核对' }, reused); }
    return this.result(record, reused);
  }

  private result(record: WechatOperation, reused: boolean): WechatDraftResult {
    const verified = record.state === 'verified';
    const uncertain = ['submitting', 'uncertain'].includes(record.state);
    return {
      platform: 'wechat', projectId: record.projectId, title: record.title, operationKey: record.key,
      status: verified ? 'filled' : uncertain ? 'result_uncertain' : 'action_required',
      stage: verified ? 'draft_verified' : uncertain ? 'draft_result_uncertain' : 'draft_verify_failed',
      message: uncertain ? (record.message ?? '上次创建草稿的结果未确认，请先在公众号后台核对，系统不会重复创建')
        : (record.message ?? '草稿尚未完成保存，请重新检查后重试'),
      mediaId: record.mediaId, saved: !!record.mediaId, verified, reused, errorCode: record.errorCode, url: WECHAT_BACKEND_URL,
    };
  }
}
