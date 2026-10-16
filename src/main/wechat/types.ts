import { z } from 'zod';
import type { ArticleDocument } from '../../shared/article-document.js';

export const wechatProjectIdSchema = z.string().uuid().transform((value) => value.toLowerCase());
export const wechatCredentialsSchema = z.object({
  appId: z.string().trim().regex(/^wx[a-zA-Z0-9]{16}$/, 'AppID 格式不正确'),
  appSecret: z.string().trim().regex(/^[a-zA-Z0-9]{32}$/, 'AppSecret 格式不正确'),
});
export type WechatCredentials = z.infer<typeof wechatCredentialsSchema>;

const characters = (maximum: number) => z.string().trim().refine((value) => [...value].length <= maximum);
export const wechatDraftOptionsSchema = z.object({
  author: characters(16).default(''),
  contentSourceUrl: z.union([z.literal(''), z.url().refine((value) => /^https?:\/\//i.test(value))]).default(''),
  openComments: z.boolean().default(false),
  onlyFansCanComment: z.boolean().default(false),
}).strict();
export type WechatDraftOptions = z.input<typeof wechatDraftOptionsSchema>;

export const wechatArticleSchema = z.object({
  article_type: z.literal('news'),
  title: z.string(),
  author: z.string(),
  digest: z.string(),
  content: z.string(),
  content_source_url: z.string(),
  thumb_media_id: z.string().min(1),
  need_open_comment: z.union([z.literal(0), z.literal(1)]),
  only_fans_can_comment: z.union([z.literal(0), z.literal(1)]),
});
export type WechatArticle = z.infer<typeof wechatArticleSchema>;
export type WechatDraftArticle = Omit<WechatArticle, 'article_type'> & { article_type?: string; url?: string };
export type WechatImage = { bytes: Buffer; mime: 'image/png' | 'image/jpeg'; name: string };
export type WechatImageBlock = Extract<ArticleDocument['blocks'][number], { type: 'image' }>;

export interface WechatDraftInput {
  projectId: string;
  /** Bind a UI submission to the account displayed when the user clicked save. */
  expectedAppId?: string;
  document: ArticleDocument;
  coverPath: string;
  options?: WechatDraftOptions;
}

export interface WechatDraftResult {
  platform: 'wechat';
  projectId: string;
  status: 'filled' | 'action_required' | 'result_uncertain';
  stage: 'draft_verified' | 'draft_verify_failed' | 'draft_result_uncertain';
  message: string;
  title: string;
  operationKey: string;
  mediaId?: string;
  /** A management page, never an expiring preview URL or a published article URL. */
  url: string;
  saved: boolean;
  verified: boolean;
  reused: boolean;
  errorCode?: string;
}

export interface WechatConnectionStatus {
  appId: string;
  connected: true;
  draftCount: number;
  draftReadVerified: true;
  draftWriteVerified: false;
}

export interface WechatConnectionSettings {
  configured: boolean;
  appId: string;
}

export const WECHAT_BACKEND_URL = 'https://mp.weixin.qq.com/';
