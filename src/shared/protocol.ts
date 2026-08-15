import { z } from 'zod';
import { articleDocumentSchema } from './article-document.js';
import type { ContentFilter, ContentKind } from '../main/content-store.js';

export const PLATFORMS = ['baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS);

export const desktopDistributionRequestSchema = z.object({
  projectId: z.string().uuid(),
  articleId: z.string().min(1),
  platforms: z.array(platformSchema).min(1).max(PLATFORMS.length).transform((values) => [...new Set(values)]),
  mode: z.enum(['fill', 'publish']),
  coverPath: z.string().default(''),
  confirmPublish: z.boolean().default(false),
}).superRefine((request, context) => {
  if (request.mode === 'publish' && !request.confirmPublish) {
    context.addIssue({ code: 'custom', path: ['confirmPublish'], message: '真实发布需要明确确认' });
  }
});

export type DesktopDistributionRequest = z.input<typeof desktopDistributionRequestSchema>;

const requestBase = z.object({
  id: z.string().min(1),
  token: z.string().min(32),
});

const articleRequest = {
  platform: z.enum(['baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease']),
  projectId: z.string().uuid(),
  document: articleDocumentSchema,
  coverPath: z.string().default(''),
} as const;

const articleRefinements = <T extends { platform: string; document: { title: string }; coverPath: string }>(request: T, context: z.RefinementCtx) => {
  if (request.platform === 'toutiao' && request.document.title.length > 30) {
    context.addIssue({ code: 'custom', path: ['document', 'title'], message: '头条号标题不能超过 30 个字符' });
  }
  if (!['zhihu', 'penguin', 'sohu'].includes(request.platform) && !request.coverPath.trim()) {
    context.addIssue({ code: 'custom', path: ['coverPath'], message: '百家号、头条号和网易号必须提供封面路径' });
  }
};

export const controlRequestSchema = z.discriminatedUnion('action', [
  requestBase.extend({ action: z.literal('status') }),
  requestBase.extend({ action: z.literal('project.list') }),
  requestBase.extend({ action: z.literal('project.current') }),
  requestBase.extend({ action: z.literal('project.get'), projectId: z.string().uuid() }),
  requestBase.extend({ action: z.literal('project.create'), project: z.record(z.string(), z.unknown()) }),
  requestBase.extend({ action: z.literal('project.update'), projectId: z.string().uuid(), project: z.record(z.string(), z.unknown()) }),
  requestBase.extend({ action: z.literal('project.select'), projectId: z.string().uuid() }),
  requestBase.extend({ action: z.literal('project.archive'), projectId: z.string().uuid() }),
  requestBase.extend({ action: z.literal('content.list'), projectId: z.string().uuid(), kind: z.string().optional(), filter: z.record(z.string(), z.unknown()).optional() }),
  requestBase.extend({ action: z.literal('content.save'), projectId: z.string().uuid(), item: z.record(z.string(), z.unknown()) }),
  requestBase.extend({ action: z.literal('content.import-material'), projectId: z.string().uuid(), sourcePath: z.string().min(1), item: z.record(z.string(), z.unknown()).optional() }),
  requestBase.extend({ action: z.literal('material.pending'), projectId: z.string().uuid(), limit: z.number().int().min(1).max(50).optional() }),
  requestBase.extend({ action: z.literal('material.get'), projectId: z.string().uuid(), materialId: z.string().min(1) }),
  requestBase.extend({ action: z.literal('material.analyze'), projectId: z.string().uuid(), materialId: z.string().min(1), analysis: z.record(z.string(), z.unknown()) }),
  requestBase.extend({ action: z.literal('topic.reserve'), projectId: z.string().uuid(), topicId: z.string().min(1), taskId: z.string().min(1), ttlMs: z.number().int().positive().max(3600000).optional() }),
  requestBase.extend({ action: z.literal('topic.release'), projectId: z.string().uuid(), topicId: z.string().min(1), taskId: z.string().min(1).optional() }),
  requestBase.extend({ action: z.literal('topic.use'), projectId: z.string().uuid(), topicId: z.string().min(1), articleId: z.string().min(1), taskId: z.string().min(1).optional() }),
  requestBase.extend({ action: z.literal('topic.variant'), projectId: z.string().uuid(), topicId: z.string().min(1), item: z.record(z.string(), z.unknown()) }),
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

export type { ContentKind };
export type { ContentFilter };

export interface DataChangeEvent {
  revision: number;
  entity: 'project' | 'content';
  action: 'created' | 'updated' | 'selected' | 'archived' | 'imported' | 'saved';
  projectId: string;
  itemId?: string;
  contentKind?: ContentKind;
  source: 'cli' | 'desktop';
  changedAt: string;
}

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
  runtimeState: 'not_loaded' | 'resident' | 'background' | 'active';
  loginState: 'not_checked';
  statusNote: string;
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
  executingPlatform: Platform | null;
  windowState: 'visible' | 'minimized' | 'hidden';
  currentProject: ProjectSummary | null;
  attentionRequired: {
    platform: Platform;
    code: 'LOGIN_REQUIRED' | 'VERIFICATION_REQUIRED' | 'RISK_CONTROL_REQUIRED';
    message: string;
    url: string;
  } | null;
  platforms: PlatformStatus[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  companyName: string;
  updatedAt: string;
}

export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  channel: 'stable' | 'beta';
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
  profileSkillPath: string | null;
  topicSkillPath: string | null;
  articleSkillPath: string | null;
  materialSkillPath: string | null;
  promptPath: string | null;
}

export interface LaunchAtLoginStatus {
  available: boolean;
  enabled: boolean;
}

export interface DiagnosticSummary {
  generatedAt: string;
  app: {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    packaged: boolean;
  };
  cli: {
    installed: boolean;
    profile: 'production';
  };
  publisher: {
    ready: boolean;
    busy: boolean;
    executingPlatform: Platform | null;
    projectSelected: boolean;
    attentionCode: DesktopStatus['attentionRequired'] extends infer T
      ? T extends { code: infer C } ? C : null
      : null;
  };
  update: Pick<UpdateStatus, 'channel' | 'phase' | 'currentVersion' | 'availableVersion'>;
}

export interface BetaActivationResult {
  accepted: boolean;
  enabled: boolean;
  message: string;
  update: UpdateStatus;
}
