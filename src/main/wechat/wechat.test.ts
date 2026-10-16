import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ArticleDocument } from '../../shared/article-document.js';
import { WechatAdapter } from './adapter.js';
import { WechatApiClient } from './api.js';
import { BODY_IMAGE_LIMIT, makeWechatArticle, prepareDocument, validateImage, verifyWechatDraft } from './document.js';
import { WechatStore, type WechatCipher } from './storage.js';
import type { WechatArticle } from './types.js';

const projectA = '11111111-1111-4111-8111-111111111111';
const projectB = '22222222-2222-4222-8222-222222222222';
const credentials = { appId: 'wx1234567890abcdef', appSecret: 'a'.repeat(32) };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const document: ArticleDocument = { title: '微信公众号草稿测试', summary: '测试摘要', tags: ['草稿'], blocks: [
  { type: 'heading', level: 2, text: '一个小标题' }, { type: 'paragraph', text: '先保存，再核对。A & B <测试>' },
  { type: 'image', src: `data:image/png;base64,${png.toString('base64')}`, caption: '示例图片' },
  { type: 'list', ordered: true, items: ['第一项', '第二项'] }, { type: 'quote', text: '引用' }, { type: 'divider' },
] };

function cipher(): WechatCipher {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: (text) => {
      const iv = randomBytes(12); const encryption = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([encryption.update(text, 'utf8'), encryption.final()]);
      return Buffer.concat([iv, encryption.getAuthTag(), encrypted]);
    },
    decrypt: (bytes) => {
      const decryption = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decryption.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decryption.update(bytes.subarray(28)), decryption.final()]).toString('utf8');
    },
  };
}

function remote() {
  const calls: { path: string; method: string; body: unknown; token: string | null }[] = [];
  let article: WechatArticle | undefined;
  const controls: {
    draftError?: 'timeout' | 'permission' | 'http'; readError?: boolean; mismatch?: boolean;
    rejectFirstToken?: boolean; tokenCount: number;
    beforeCreate?: () => Promise<void>;
  } = { tokenCount: 0 };
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.weixin.qq.com');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ path: url.pathname, method: init?.method ?? 'GET', body, token: url.searchParams.get('access_token') });
    if (url.pathname === '/cgi-bin/stable_token') { controls.tokenCount++; return Response.json({ access_token: `test-token-${controls.tokenCount}`, expires_in: 7200 }); }
    if (controls.rejectFirstToken && url.searchParams.get('access_token') === 'test-token-1') return Response.json({ errcode: 40014, errmsg: 'invalid token' });
    if (url.pathname === '/cgi-bin/draft/count') return Response.json({ total_count: 4 });
    if (url.pathname === '/cgi-bin/material/add_material') { expect(url.searchParams.get('type')).toBe('image'); return Response.json({ media_id: 'cover-1' }); }
    if (url.pathname === '/cgi-bin/media/uploadimg') return Response.json({ url: 'http://mmbiz.qpic.cn/mmbiz_png/test/0?wx_fmt=png' });
    if (url.pathname === '/cgi-bin/draft/add') {
      await controls.beforeCreate?.();
      article = body.articles[0];
      if (controls.draftError === 'timeout') throw new Error('https://api.weixin.qq.com/?access_token=do-not-leak');
      if (controls.draftError === 'http') return new Response('proxy failure', { status: 502 });
      if (controls.draftError === 'permission') return Response.json({ errcode: 48001, errmsg: 'secret-do-not-leak' });
      return Response.json({ media_id: 'draft-1' });
    }
    if (url.pathname === '/cgi-bin/draft/get') {
      if (controls.readError) throw new Error('network error');
      return Response.json({ news_item: [{ ...article, ...(controls.mismatch ? { content: '<p>正文丢失</p>' } : {}) }] });
    }
    throw new Error(`Unexpected API ${url.pathname}`);
  }) as typeof fetch;
  return { calls, controls, fetcher, get article() { return article; } };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'geo-wechat-test-'));
  const store = new WechatStore(root, cipher());
  await store.saveCredentials(projectA, credentials);
  const server = remote();
  const createAdapter = () => new WechatAdapter({ store, createClient: (value) => new WechatApiClient(value, server.fetcher) });
  const adapter = createAdapter(); const coverPath = join(root, 'cover.png'); await writeFile(coverPath, png);
  const input = { projectId: projectA, document, coverPath };
  return { root, store, server, createAdapter, adapter, input };
}

describe('WeChat official API', () => {
  it('uses stable tokens, GET draft count and caches without claiming write permission', async () => {
    const server = remote(); const api = new WechatApiClient(credentials, server.fetcher);
    const [a, b] = await Promise.all([api.testConnection(), api.testConnection()]);
    expect(a).toEqual(b); expect(a.draftWriteVerified).toBe(false);
    expect(server.controls.tokenCount).toBe(1);
    expect(server.calls[0]!.body).toEqual({ grant_type: 'client_credential', appid: credentials.appId, secret: credentials.appSecret, force_refresh: false });
    expect(server.calls.filter((call) => call.path.endsWith('/count')).every((call) => call.method === 'GET' && call.body === undefined)).toBe(true);
  });

  it('refreshes once after explicit token rejection', async () => {
    const server = remote(); server.controls.rejectFirstToken = true;
    await expect(new WechatApiClient(credentials, server.fetcher).testConnection()).resolves.toMatchObject({ connected: true });
    expect(server.controls.tokenCount).toBe(2);
  });

  it('refreshes expired tokens with a safety margin', async () => {
    const server = remote(); let now = 0;
    const api = new WechatApiClient(credentials, server.fetcher, () => now);
    await api.testConnection(); now = 7080_000; await api.testConnection(); expect(server.controls.tokenCount).toBe(2);
  });

  it('redacts remote error text while preserving whitelist guidance', async () => {
    const fetcher = vi.fn(async () => Response.json({ errcode: 40164, errmsg: 'invalid ip 203.0.113.7, secret=super-private' })) as typeof fetch;
    const error = await new WechatApiClient(credentials, fetcher).testConnection().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'WECHAT_IP_NOT_ALLOWED', details: { whitelistIp: '203.0.113.7' } });
    expect(String(error)).not.toContain('super-private');
  });
});

describe('WeChat local project storage', () => {
  it('encrypts credentials and rejects cross-project copies and path traversal', async () => {
    const { root, store, adapter } = await setup();
    const path = join(store.projectDirectory(projectA), 'credentials.bin');
    expect((await readFile(path)).includes(Buffer.from(credentials.appSecret))).toBe(false);
    expect(await adapter.connectionSettings(projectA)).toEqual({ configured: true, appId: credentials.appId });
    expect(await adapter.connectionSettings(projectB)).toEqual({ configured: false, appId: '' });
    await mkdir(store.projectDirectory(projectB), { recursive: true });
    await copyFile(path, join(store.projectDirectory(projectB), 'credentials.bin'));
    await expect(store.readCredentials(projectB)).rejects.toThrow('WECHAT_CREDENTIALS_UNREADABLE');
    await expect(store.readCredentials('../escape')).rejects.toThrow('WECHAT_PROJECT_INVALID');
    const disabled = new WechatStore(root, { ...cipher(), available: () => false });
    await expect(disabled.saveCredentials(projectA, credentials)).rejects.toThrow('WECHAT_ENCRYPTION_UNAVAILABLE');
    await adapter.clearCredentials(projectA); expect(await store.readCredentials(projectA)).toBeNull();
  });

  it('does not overwrite credentials or submit a second operation while a project is busy', async () => {
    const { adapter, server, input } = await setup();
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    server.controls.beforeCreate = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); };
    const pending = adapter.fillDraft(input); await waiting;
    try {
      await expect(adapter.fillDraft(input)).rejects.toThrow('WECHAT_BUSY');
      await expect(adapter.clearCredentials(projectA)).rejects.toThrow('WECHAT_BUSY');
    } finally { release(); }
    expect((await pending).verified).toBe(true);
  });
});

describe('WeChat draft workflow', () => {
  it('includes layout in draft identity and sends styles through the API', async () => {
    const { adapter, server, input } = await setup();
    const plain = await adapter.fillDraft(input);
    const styled = { ...input, document: { ...document, wechatLayout: { version: 1 as const, theme: 'moyu-green' as const, fontSize: 16, lineHeight: 1.9, paragraphSpacing: 20, header: true } } };
    const result = await adapter.fillDraft(styled);
    expect(result.verified).toBe(true); expect(result.operationKey).not.toBe(plain.operationKey);
    expect(server.article!.content).toContain('background-color:#ECFDF5;');
    expect((await adapter.fillDraft(styled)).reused).toBe(true);
    expect(server.calls.filter((call) => call.path.endsWith('/draft/add'))).toHaveLength(2);
  });

  it('uploads both image types, saves and verifies, and reuses a draft after restart', async () => {
    const { adapter, server, input, createAdapter, store } = await setup();
    const result = await adapter.fillDraft(input);
    expect(result).toMatchObject({ status: 'filled', saved: true, verified: true, mediaId: 'draft-1', reused: false });
    expect(server.article!.content).toContain('http://mmbiz.qpic.cn/');
    expect(server.article!.content).not.toContain('data:image');
    expect(server.calls.find((call) => call.path.endsWith('/uploadimg'))!.body).toBeInstanceOf(FormData);
    expect(server.calls.every((call) => !/freepublish|mass/.test(call.path))).toBe(true);
    const again = await createAdapter().fillDraft(input);
    expect(again).toMatchObject({ verified: true, reused: true, mediaId: 'draft-1' });
    expect(server.calls.filter((call) => call.path.endsWith('/draft/add'))).toHaveLength(1);
    expect(server.calls.filter((call) => call.path.endsWith('/material/add_material'))).toHaveLength(1);
    const serialized = JSON.stringify(await store.listOperations(projectA));
    expect(serialized).not.toContain(credentials.appSecret); expect(serialized).not.toContain('test-token');
  });

  it.each(['timeout', 'http'] as const)('does not resubmit a draft after %s uncertainty, including after restart', async (failure) => {
    const { adapter, server, input, createAdapter } = await setup(); server.controls.draftError = failure;
    const result = await adapter.fillDraft(input);
    expect(result).toMatchObject({ status: 'result_uncertain', saved: false, verified: false });
    const retry = await createAdapter().fillDraft(input);
    expect(retry.status).toBe('result_uncertain');
    expect(server.calls.filter((call) => call.path.endsWith('/draft/add'))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
  });

  it('allows retry after an explicit permission rejection', async () => {
    const { adapter, server, input } = await setup(); server.controls.draftError = 'permission';
    const denied = await adapter.fillDraft(input);
    expect(denied).toMatchObject({ status: 'action_required', saved: false, errorCode: 'WECHAT_PERMISSION_REQUIRED' });
    server.controls.draftError = undefined;
    expect((await adapter.fillDraft(input)).verified).toBe(true);
  });

  it('keeps the media ID when readback fails and only rereads on retry', async () => {
    const { adapter, server, input } = await setup(); server.controls.readError = true;
    const first = await adapter.fillDraft(input);
    expect(first).toMatchObject({ status: 'action_required', saved: true, verified: false, mediaId: 'draft-1' });
    server.controls.readError = false;
    expect((await adapter.recheckDraft(projectA, first.operationKey)).verified).toBe(true);
    expect(server.calls.filter((call) => call.path.endsWith('/draft/add'))).toHaveLength(1);
  });

  it('reports content mismatch rather than treating any returned draft as success', async () => {
    const { adapter, server, input } = await setup(); server.controls.mismatch = true;
    expect(await adapter.fillDraft(input)).toMatchObject({ saved: true, verified: false, errorCode: 'WECHAT_DRAFT_MISMATCH' });
  });

  it('blocks duplicate creation when a crash left a submitting record', async () => {
    const { adapter, store, server, input } = await setup();
    const first = await adapter.fillDraft(input); const record = (await store.readOperation(projectA, first.operationKey))!;
    delete record.mediaId; delete record.message; record.state = 'submitting'; await store.saveOperation(record);
    expect((await adapter.fillDraft(input)).status).toBe('result_uncertain');
    expect(server.calls.filter((call) => call.path.endsWith('/draft/add'))).toHaveLength(1);
  });

  it('blocks reuse of records after switching the connected account', async () => {
    const { adapter, input } = await setup(); const first = await adapter.fillDraft(input);
    await adapter.saveCredentials(projectA, { ...credentials, appId: 'wxabcdef1234567890' });
    await expect(adapter.recheckDraft(projectA, first.operationKey)).rejects.toThrow('WECHAT_ACCOUNT_CHANGED');
    await expect(adapter.recheckDraft(projectB, first.operationKey)).rejects.toThrow('WECHAT_NOT_CONFIGURED');
  });

  it('stops before any remote write if the displayed account differs from the saved account', async () => {
    const { adapter, server, input } = await setup();
    await expect(adapter.fillDraft({ ...input, expectedAppId: 'wxabcdef1234567890' })).rejects.toThrow('WECHAT_ACCOUNT_CHANGED');
    expect(server.calls).toHaveLength(0);
  });

  it('validates title and every body image before contacting WeChat', async () => {
    const { adapter, server, input } = await setup();
    await expect(adapter.fillDraft({ ...input, document: { ...document, title: '字'.repeat(33) } })).rejects.toThrow('WECHAT_TITLE_TOO_LONG');
    await expect(adapter.fillDraft({ ...input, document: { ...document, blocks: [{ type: 'image', src: 'https://example.com/photo.png' }] } })).rejects.toThrow('WECHAT_IMAGE_UNRESOLVED');
    expect(server.calls).toHaveLength(0);
    expect(() => validateImage(Buffer.concat([png, Buffer.alloc(BODY_IMAGE_LIMIT)]))).toThrow('WECHAT_IMAGE_SIZE');
    expect(() => validateImage(Buffer.from('this is not a PNG'))).toThrow('WECHAT_IMAGE_FORMAT');
  });

  it('fails closed when the post-create journal write fails', async () => {
    const { adapter, store, input, server } = await setup();
    const original = store.saveOperation.bind(store);
    const mock = vi.spyOn(store, 'saveOperation').mockImplementation(async (record) => {
      if (record.state === 'created') throw new Error('disk full');
      await original(record);
    });
    const first = await adapter.fillDraft(input);
    expect(first).toMatchObject({ status: 'result_uncertain', saved: true, mediaId: 'draft-1' }); mock.mockRestore();
    expect((await adapter.fillDraft(input)).status).toBe('result_uncertain');
    expect(server.calls.filter((call) => call.path.endsWith('/draft/add'))).toHaveLength(1);
  });
});

describe('WeChat content compatibility', () => {
  it('accepts harmless WeChat wrappers but detects text, image, cover and structure loss', () => {
    const article = makeWechatArticle(document, {}, 'cover-1', new Map([[2, 'https://mmbiz.qpic.cn/test.png']]));
    expect(() => verifyWechatDraft(article, [{ ...article, content: `<section>${article.content.replace('<p>', '<p style="color:#333">')}</section>` }])).not.toThrow();
    for (const content of [article.content.replace('先保存', ''), article.content.replace(/<img[^>]+>/, ''), article.content.replace(/h2/g, 'p')]) {
      expect(() => verifyWechatDraft(article, [{ ...article, content }])).toThrow('WECHAT_DRAFT_MISMATCH');
    }
    expect(() => verifyWechatDraft(article, [{ ...article, thumb_media_id: 'wrong-cover' }])).toThrow('WECHAT_DRAFT_MISMATCH');
    expect(() => prepareDocument({ ...document, blocks: [{ type: 'paragraph', text: '文'.repeat(12_000) }, { type: 'paragraph', text: '文'.repeat(12_000) }] })).toThrow('WECHAT_CONTENT_TOO_LONG');
  });

});
