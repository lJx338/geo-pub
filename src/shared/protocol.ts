import { z } from 'zod';

export const PLATFORMS = ['baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const CONTROL_PROTOCOL_VERSION = 1;
/** Protocol 0 is the released CLI format before explicit version metadata. */
export const MIN_SUPPORTED_CONTROL_PROTOCOL_VERSION = 0;
export const CONTROL_CAPABILITIES = [
  'status',
  'platform.open',
  'platform.inspect',
  'draft.fill',
  'draft.publish',
] as const;

export const platformSchema = z.enum(PLATFORMS);

const requestBase = z.object({
  id: z.string().min(1),
  token: z.string().min(32),
  protocolVersion: z.number().int().optional().default(MIN_SUPPORTED_CONTROL_PROTOCOL_VERSION),
  clientVersion: z.string().min(1).optional(),
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
  runtimeState: 'not_loaded' | 'resident' | 'active';
  loginState: 'not_checked';
  statusNote: string;
  loading: boolean;
  url: string;
  title: string;
}

export type PublishTaskAction = 'open' | 'inspect' | 'fill' | 'publish';
export type PublishTaskPhase = 'opening' | 'filling' | 'pre_publish' | 'dispatching' | 'dispatched' | 'reconciling';
export type PublishTaskStatus = 'running' | 'success' | 'failed' | 'action_required' | 'result_uncertain';

/** A compact, user-facing task record. Article content is never persisted here. */
export interface PublishTaskSnapshot {
  taskId: string;
  platform: Platform;
  action: PublishTaskAction;
  phase: PublishTaskPhase;
  status: PublishTaskStatus;
  title?: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  message?: string;
  errorCode?: string;
  evidencePath?: string;
  lastKnownUrl?: string;
}

export interface DesktopStatus {
  version: string;
  cliPath?: string | null;
  pid: number;
  ready: boolean;
  busy: boolean;
  activeTask?: {
    taskId: string;
    action: PublishTaskAction;
    platform: Platform;
    phase: PublishTaskPhase;
    title?: string;
    startedAt: string;
    deadlineAt: string;
  } | null;
  recentTasks: PublishTaskSnapshot[];
  resourceDiagnostics?: {
    rssBytes: number;
    heapUsedBytes: number;
    residentViews: number;
    cookieSubscriptions: number;
    evidenceBytes?: number;
    cacheBytes?: number;
    lastMaintenanceAt?: string | null;
  };
  activePlatform: Platform | null;
  platforms: PlatformStatus[];
  worker?: {
    state: 'starting' | 'ready' | 'unavailable';
    pid: number | null;
    protocolVersion: number;
    lastError: string | null;
  };
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
