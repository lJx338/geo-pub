import { open } from 'node:fs/promises';
import { articleDocumentSchema, renderArticleDocument, type ArticleDocument } from '../../shared/article-document.js';
import { isWechatImageUrl } from './api.js';
import { WechatError } from './errors.js';
import { wechatDraftOptionsSchema, type WechatArticle, type WechatDraftArticle, type WechatDraftOptions, type WechatImage, type WechatImageBlock } from './types.js';

export const BODY_IMAGE_LIMIT = 1_000_000;
export const COVER_IMAGE_LIMIT = 10_000_000;
export type WechatMaterialResolver = (projectId: string, block: WechatImageBlock) => Promise<Buffer>;
export type WechatBodyImageCompressor = (bytes: Buffer) => Buffer;

export function validateImage(bytes: Buffer, cover = false): WechatImage {
  if (bytes.length === 0 || bytes.length >= (cover ? COVER_IMAGE_LIMIT : BODY_IMAGE_LIMIT)) {
    throw new WechatError('WECHAT_IMAGE_SIZE', cover ? '封面图片需小于 10 MB' : '每张正文图片需小于 1 MB，请先压缩图片');
  }
  const mime = detectImageMime(bytes);
  return { bytes, mime, name: mime === 'image/png' ? 'image.png' : 'image.jpg' };
}

function detectImageMime(bytes: Buffer): WechatImage['mime'] {
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) throw new WechatError('WECHAT_IMAGE_FORMAT', '请使用有效的 PNG 或 JPEG 图片');
  return png ? 'image/png' : 'image/jpeg';
}

export async function readLocalImage(path: string, cover = false): Promise<WechatImage> {
  let file;
  try {
    file = await open(path, 'r');
    const info = await file.stat();
    if (!info.isFile() || info.size >= (cover ? COVER_IMAGE_LIMIT : BODY_IMAGE_LIMIT)) throw new WechatError('WECHAT_IMAGE_SIZE', cover ? '封面图片需小于 10 MB' : '正文图片需小于 1 MB');
    const bytes = Buffer.alloc((cover ? COVER_IMAGE_LIMIT : BODY_IMAGE_LIMIT));
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return validateImage(bytes.subarray(0, total), cover);
  } catch (error) {
    if (error instanceof WechatError) throw error;
    throw new WechatError('WECHAT_IMAGE_UNREADABLE', '无法读取图片，请重新选择本地文件');
  } finally { await file?.close(); }
}

export function prepareDocument(value: ArticleDocument, options: WechatDraftOptions = {}) {
  const parsed = articleDocumentSchema.safeParse(value);
  const settings = wechatDraftOptionsSchema.safeParse(options);
  if (!parsed.success || !settings.success) throw new WechatError('WECHAT_ARTICLE_INVALID', '文章内容或公众号选项格式不正确');
  if ([...parsed.data.title].length > 32) throw new WechatError('WECHAT_TITLE_TOO_LONG', '微信公众号标题最多 32 个字，请缩短后再保存');
  // Replace unresolved images solely for size preflight. Real images are uploaded later.
  const placeholder = { ...parsed.data, blocks: parsed.data.blocks.map((block) => block.type === 'image' ? { ...block, src: 'https://mmbiz.qpic.cn/placeholder' } : block) };
  validateContent(renderArticleDocument(placeholder, 'wechat').html);
  return { document: parsed.data, options: settings.data };
}

export function validateContent(html: string): void {
  if (html.length > 20_000 || Buffer.byteLength(html, 'utf8') >= 1_000_000) {
    throw new WechatError('WECHAT_CONTENT_TOO_LONG', '文章排版内容超过微信草稿限制，请缩短正文后重试');
  }
}

/** Material IDs are resolved by the host, always in the selected customer project. */
export async function loadBodyImages(
  projectId: string,
  document: ArticleDocument,
  { resolveMaterial, compressBodyImage }: { resolveMaterial?: WechatMaterialResolver; compressBodyImage?: WechatBodyImageCompressor } = {},
): Promise<Map<number, WechatImage>> {
  const result = new Map<number, WechatImage>();
  for (const [index, block] of document.blocks.entries()) {
    if (block.type !== 'image') continue;
    let bytes: Buffer;
    if (block.materialId && resolveMaterial) {
      bytes = await resolveMaterial(projectId, block);
    } else {
      const match = block.src?.match(/^data:image\/(?:png|jpeg);base64,([a-z\d+/]+={0,2})$/i);
      if (!match?.[1]) {
        throw new WechatError('WECHAT_IMAGE_UNRESOLVED', '正文图片需来自本项目素材库或 PNG/JPEG 内嵌图片；网络图片请先导入素材库');
      }
      bytes = Buffer.from(match[1], 'base64');
    }
    if (bytes.length >= BODY_IMAGE_LIMIT && compressBodyImage) {
      detectImageMime(bytes);
      bytes = compressBodyImage(bytes);
    }
    result.set(index, validateImage(bytes));
  }
  return result;
}

export function makeWechatArticle(document: ArticleDocument, options: WechatDraftOptions, coverId: string, imageUrls: Map<number, string>): WechatArticle {
  const prepared = prepareDocument(document, options);
  const resolved = { ...prepared.document, blocks: prepared.document.blocks.map((block, index) => {
    if (block.type !== 'image') return block;
    const src = imageUrls.get(index);
    if (!src) throw new WechatError('WECHAT_IMAGE_UNRESOLVED', '正文图片尚未上传完成');
    return { ...block, src };
  }) };
  const content = renderArticleDocument(resolved, 'wechat').html;
  validateContent(content);
  return {
    article_type: 'news', title: resolved.title, author: prepared.options.author,
    digest: resolved.summary ?? '', content, content_source_url: prepared.options.contentSourceUrl,
    thumb_media_id: coverId, need_open_comment: prepared.options.openComments ? 1 : 0,
    only_fans_can_comment: prepared.options.openComments && prepared.options.onlyFansCanComment ? 1 : 0,
  };
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const point = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()] ?? match;
  });
}

function imageKey(source: string): string {
  const address = decodeEntities(source).trim().replace(/^http:/i, 'https:').replace(/^\/\//, 'https://');
  const url = URL.parse(address);
  if (url && !url.port && isWechatImageUrl(url)) {
    // WeChat keeps the media ID when rewriting CDN format, size, or display parameters.
    const id = /^\/(?:sz_)?mmbiz(?:_[a-z0-9]+)?\/([^/]+)(?:\/\d+)?\/?$/.exec(url.pathname)?.[1];
    if (id) return `wechat:${id}`;
  }
  return `url:${address}`;
}

function imageSignature(tag: string): string[] {
  const sources = new Map<string, string>();
  for (const [, name, quoted, singleQuoted, unquoted] of tag.matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g)) {
    const attribute = name!.toLowerCase();
    if (!sources.has(attribute)) sources.set(attribute, (quoted ?? singleQuoted ?? unquoted ?? '').trim());
  }
  const src = sources.get('src') || '';
  const deferred = sources.get('data-src') || '';
  const primary = imageKey(deferred || src);
  // A lazy-loaded image may carry an inline placeholder alongside the CDN URL.
  if (deferred && src && !/^(?:data:image\/|about:blank$)/i.test(src)) {
    const displayed = imageKey(src);
    if (displayed !== primary) return [primary, displayed];
  }
  return [primary];
}

function signature(html: string) {
  // Accept WeChat's extra attributes/wrappers, but preserve text order and block boundaries.
  const text = decodeEntities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|h[1-6]|li|blockquote|section)>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/[\t \u00a0]+/g, ' ').split(/\n/).map((line) => line.trim()).filter(Boolean).join('\n');
  const images = [...html.matchAll(/<img(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)].map(([tag]) => imageSignature(tag));
  const structures = ['h[23]', '(?:ol|ul)', 'li', 'blockquote', 'hr'].map((tag) => [...html.matchAll(new RegExp(`<${tag}\\b`, 'gi'))].length);
  return JSON.stringify({ text, images, structures });
}

export function verifyWechatDraft(expected: WechatArticle, actual: WechatDraftArticle[]): void {
  const item = actual[0];
  if (actual.length !== 1 || !item || item.title !== expected.title || item.thumb_media_id !== expected.thumb_media_id
    || (item.author ?? '') !== expected.author || (expected.digest && item.digest !== expected.digest)
    || (item.content_source_url ?? '') !== expected.content_source_url
    || Number(item.need_open_comment ?? 0) !== expected.need_open_comment
    || (expected.need_open_comment && Number(item.only_fans_can_comment ?? 0) !== expected.only_fans_can_comment)
    || signature(item.content) !== signature(expected.content)) {
    throw new WechatError('WECHAT_DRAFT_MISMATCH', '草稿已保存，但读回内容与原文不一致，请在公众号后台检查');
  }
}
