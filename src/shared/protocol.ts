import { z } from 'zod';

export const PLATFORMS = ['baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS);

const requestBase = z.object({
  id: z.string().min(1),
  token: z.string().min(32),
});

const articleRequest = {
  platform: z.enum(['baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease']),
  title: z.string().trim().min(2).max(64),
  html: z.string().min(1),
  coverPath: z.string(),
  tags: z.array(z.string()).max(20).default([]),
} as const;

const articleRefinements = <T extends { platform: string; title: string; coverPath: string }>(request: T, context: z.RefinementCtx) => {
  if (request.platform === 'toutiao' && request.title.length > 30) {
    context.addIssue({ code: 'custom', path: ['title'], message: '头条号标题不能超过 30 个字符' });
  }
  if (!['zhihu', 'penguin', 'sohu'].includes(request.platform) && !request.coverPath.trim()) {
    context.addIssue({ code: 'custom', path: ['coverPath'], message: '百家号、头条号和网易号必须提供封面路径' });
  }
};

export const controlRequestSchema = z.discriminatedUnion('action', [
  requestBase.extend({ action: z.literal('status') }),
  requestBase.extend({ action: z.literal('app.show') }),
  requestBase.extend({ action: z.literal('platform.open'), platform: platformSchema }),
  requestBase.extend({ action: z.literal('platform.inspect'), platform: platformSchema }),
  requestBase.extend({
    action: z.literal('draft.fill'),
    ...articleRequest,
  }).superRefine(articleRefinements),
  requestBase.extend({
    action: z.literal('draft.publish'),
    ...articleRequest,
    confirmPublish: z.literal(true),
  }).superRefine(articleRefinements),
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
  busy: boolean;
  activePlatform: Platform | null;
  platforms: PlatformStatus[];
}

export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  message: string;
  checkedAt: string | null;
  canRestart: boolean;
}

export interface WorkBuddyIntegrationStatus {
  available: boolean;
  prepared: boolean;
  skillPath: string | null;
  promptPath: string | null;
}
