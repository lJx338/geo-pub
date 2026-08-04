import { z } from 'zod';

export const PLATFORMS = ['baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS);

const requestBase = z.object({
  id: z.string().min(1),
  token: z.string().min(32),
});

export const controlRequestSchema = z.discriminatedUnion('action', [
  requestBase.extend({ action: z.literal('status') }),
  requestBase.extend({ action: z.literal('app.show') }),
  requestBase.extend({ action: z.literal('platform.open'), platform: platformSchema }),
  requestBase.extend({ action: z.literal('platform.inspect'), platform: platformSchema }),
  requestBase.extend({
    action: z.literal('draft.fill'),
    platform: z.enum(['baijia', 'toutiao', 'zhihu']),
    title: z.string().trim().min(2).max(64),
    html: z.string().min(1),
    coverPath: z.string(),
  }).refine((request) => request.platform !== 'toutiao' || request.title.length <= 30, {
    path: ['title'],
    message: '头条号标题不能超过 30 个字符',
  }).refine((request) => request.platform === 'zhihu' || request.coverPath.trim().length > 0, {
    path: ['coverPath'],
    message: '百家号和头条号必须提供封面路径',
  }),
]);

export type ControlRequest = z.infer<typeof controlRequestSchema>;

export interface ControlResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PlatformStatus {
  platform: Platform;
  created: boolean;
  attached: boolean;
  loading: boolean;
  url: string;
  title: string;
}

export interface DesktopStatus {
  version: string;
  cliPath?: string | null;
  pid: number;
  ready: boolean;
  activePlatform: Platform | null;
  platforms: PlatformStatus[];
}
