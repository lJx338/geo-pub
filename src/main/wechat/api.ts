import { WechatError, wechatApiError } from './errors.js';
import { wechatCredentialsSchema, type WechatArticle, type WechatConnectionStatus, type WechatCredentials, type WechatDraftArticle, type WechatImage } from './types.js';

const API_ROOT = 'https://api.weixin.qq.com';
const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001]);
type Payload = Record<string, unknown>;

export class WechatApiClient {
  private readonly credentials: WechatCredentials;
  private token: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;

  constructor(credentials: WechatCredentials, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    const parsed = wechatCredentialsSchema.safeParse(credentials);
    if (!parsed.success) throw new WechatError('WECHAT_CREDENTIALS_INVALID', '请填写正确的 AppID 和 AppSecret');
    this.credentials = parsed.data;
  }

  private async request(path: string, body: string | FormData | undefined, token?: string, query: Record<string, string> = {}, mutating = false): Promise<Payload> {
    const url = new URL(path, API_ROOT);
    if (token) url.searchParams.set('access_token', token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let result: unknown;
    try {
      const response = await this.fetcher(url, {
        method: body === undefined ? 'GET' : 'POST', body,
        headers: typeof body === 'string' ? { 'content-type': 'application/json; charset=utf-8' } : undefined,
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      // A proxy HTTP error is not proof that a write failed at WeChat.
      if (!response.ok) throw new Error('HTTP response is not successful');
      result = await response.json();
    } catch {
      throw new WechatError(mutating ? 'WECHAT_WRITE_UNCERTAIN' : 'WECHAT_NETWORK_ERROR',
        mutating ? '请求结果未确认，请先核对公众号后台，勿重复创建草稿' : '微信接口暂时无法连接，请检查网络后重试', {}, mutating);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new WechatError('WECHAT_RESPONSE_INVALID', '微信返回了无法识别的结果', {}, mutating);
    }
    const data = result as Payload;
    if (typeof data.errcode === 'number' && data.errcode !== 0) throw wechatApiError(data.errcode, data.errmsg);
    if (data.errcode !== undefined && typeof data.errcode !== 'number') {
      throw new WechatError('WECHAT_RESPONSE_INVALID', '微信返回了无法识别的错误码', {}, mutating);
    }
    return data;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = (async () => {
        const data = await this.request('/cgi-bin/stable_token', JSON.stringify({
          grant_type: 'client_credential', appid: this.credentials.appId,
          secret: this.credentials.appSecret, force_refresh: false,
        }));
        if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
          throw new WechatError('WECHAT_RESPONSE_INVALID', '微信没有返回有效的接口凭据');
        }
        this.token = { value: data.access_token, expiresAt: this.now() + Math.max(0, data.expires_in - 120) * 1000 };
        return data.access_token;
      })();
    }
    try { return await this.tokenRequest; } finally { this.tokenRequest = undefined; }
  }

  private async authenticated(path: string, body: () => string | FormData | undefined, query: Record<string, string> = {}, mutating = false): Promise<Payload> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      try { return await this.request(path, body(), token, query, mutating); }
      catch (error) {
        // Only an explicit token rejection is safe to retry, never a timeout.
        if (attempt === 0 && error instanceof WechatError && INVALID_TOKEN_CODES.has(error.details.apiCode ?? 0)) {
          if (this.token?.value === token) this.token = undefined;
          continue;
        }
        throw error;
      }
    }
    throw new WechatError('WECHAT_TOKEN_INVALID', '接口凭据无法刷新');
  }

  async testConnection(): Promise<WechatConnectionStatus> {
    const data = await this.authenticated('/cgi-bin/draft/count', () => undefined);
    if (typeof data.total_count !== 'number' || !Number.isInteger(data.total_count) || data.total_count < 0) {
      throw new WechatError('WECHAT_RESPONSE_INVALID', '微信没有返回有效的草稿数量');
    }
    return { appId: this.credentials.appId, connected: true, draftCount: data.total_count, draftReadVerified: true, draftWriteVerified: false };
  }

  private mediaBody(image: WechatImage): FormData {
    const form = new FormData();
    form.append('media', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), image.name);
    return form;
  }

  async uploadBodyImage(image: WechatImage): Promise<string> {
    const data = await this.authenticated('/cgi-bin/media/uploadimg', () => this.mediaBody(image), {}, true);
    if (typeof data.url !== 'string' || !isWechatImageUrl(data.url)) {
      throw new WechatError('WECHAT_IMAGE_URL_INVALID', '微信没有返回有效的正文图片地址', {}, true);
    }
    return data.url;
  }

  async uploadCover(image: WechatImage): Promise<string> {
    const data = await this.authenticated('/cgi-bin/material/add_material', () => this.mediaBody(image), { type: 'image' }, true);
    if (typeof data.media_id !== 'string' || !data.media_id) throw new WechatError('WECHAT_RESPONSE_INVALID', '微信没有返回封面素材编号', {}, true);
    return data.media_id;
  }

  async createDraft(article: WechatArticle): Promise<string> {
    const data = await this.authenticated('/cgi-bin/draft/add', () => JSON.stringify({ articles: [article] }), {}, true);
    if (typeof data.media_id !== 'string' || !data.media_id) throw new WechatError('WECHAT_WRITE_UNCERTAIN', '草稿创建结果缺少编号，请先核对公众号后台', {}, true);
    return data.media_id;
  }

  async getDraft(mediaId: string): Promise<WechatDraftArticle[]> {
    if (!mediaId || mediaId.length > 256) throw new WechatError('WECHAT_DRAFT_ID_INVALID', '草稿编号不正确');
    const data = await this.authenticated('/cgi-bin/draft/get', () => JSON.stringify({ media_id: mediaId }));
    if (!Array.isArray(data.news_item) || data.news_item.length === 0 || data.news_item.some((item) =>
      !item || typeof item !== 'object' || typeof item.title !== 'string' || typeof item.content !== 'string' || typeof item.thumb_media_id !== 'string')) {
      throw new WechatError('WECHAT_RESPONSE_INVALID', '微信没有返回有效的草稿内容');
    }
    return data.news_item as WechatDraftArticle[];
  }
}

export function isWechatImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && (url.hostname === 'mmbiz.qpic.cn' || url.hostname.endsWith('.qpic.cn') || url.hostname === 'mmbiz.qlogo.cn');
  } catch { return false; }
}
