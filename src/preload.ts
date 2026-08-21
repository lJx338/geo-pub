import { contextBridge, ipcRenderer } from 'electron';
import type { BetaActivationResult, DataChangeEvent, DesktopDistributionRequest, DiagnosticSummary, DesktopStatus, LaunchAtLoginStatus, Platform, PlatformStatus, UpdateStatus, WorkBuddyIntegrationStatus } from './shared/protocol.js';
import type { Project, ProjectInput } from './main/project-store.js';
import type { ContentFilter, ContentInput, ContentItem, ContentKind } from './main/content-store.js';

// 反检测：确保不暴露任何Electron相关的全局对象
// 删除可能被注入的 process 和 require
if (typeof window !== 'undefined') {
  // @ts-expect-error - 删除可能的Electron特征
  delete window.process;
  // @ts-expect-error - 删除可能的Electron特征
  delete window.require;
  // @ts-expect-error - 删除可能的Electron特征
  delete window.module;
  // @ts-expect-error - 删除可能的Electron特征
  delete window.__dirname;
  // @ts-expect-error - 删除可能的Electron特征
  delete window.__filename;
}

contextBridge.exposeInMainWorld('geoPublisher', {
  status: (): Promise<DesktopStatus> => ipcRenderer.invoke('geo:status'),
  openPlatform: (platform: Platform): Promise<PlatformStatus> => ipcRenderer.invoke('geo:open-platform', platform),
  hidePlatform: (): Promise<DesktopStatus> => ipcRenderer.invoke('geo:hide-platform'),
  chooseDistributionCover: (): Promise<{ canceled: boolean; filePath: string }> => ipcRenderer.invoke('geo:distribution-cover-choose'),
  runDistribution: (input: DesktopDistributionRequest): Promise<{ records: ContentItem[] }> => ipcRenderer.invoke('geo:distribution-run', input),
  projects: (): Promise<{ projects: Project[]; currentProject: Project | null }> => ipcRenderer.invoke('geo:projects-list'),
  workspaceSnapshot: (): Promise<{ revision: number; projects: Project[]; currentProject: Project | null; items: ContentItem[]; contentCounts: Record<string, number> }> => ipcRenderer.invoke('geo:workspace-snapshot'),
  dataRevision: (): Promise<number> => ipcRenderer.invoke('geo:data-revision'),
  contentList: (projectId: string, kind?: ContentKind, filter?: ContentFilter): Promise<{ items: ContentItem[] }> => ipcRenderer.invoke('geo:content-list', projectId, kind, filter),
  contentSave: (projectId: string, input: ContentInput): Promise<{ item: ContentItem }> => ipcRenderer.invoke('geo:content-save', projectId, input),
  contentDelete: (projectId: string, itemId: string): Promise<{ item: ContentItem }> => ipcRenderer.invoke('geo:content-delete', projectId, itemId),
  contentImportMaterial: (projectId: string, sourcePath: string, input?: Omit<ContentInput, 'kind'>): Promise<{ item: ContentItem }> => ipcRenderer.invoke('geo:content-import-material', projectId, sourcePath, input),
  contentChooseMaterial: (projectId: string): Promise<{ canceled: boolean; items: ContentItem[] }> => ipcRenderer.invoke('geo:content-choose-material', projectId),
  materialThumbnail: (projectId: string, materialId: string): Promise<{ dataUrl: string; width: number; height: number }> => ipcRenderer.invoke('geo:material-thumbnail', projectId, materialId),
  topicVariant: (projectId: string, topicId: string, input: ContentInput): Promise<{ item: ContentItem }> => ipcRenderer.invoke('geo:topic-variant', projectId, topicId, input),
  createProject: (input: ProjectInput): Promise<{ project: Project; currentProject: Project }> => ipcRenderer.invoke('geo:project-create', input),
  updateProject: (id: string, input: Partial<ProjectInput>): Promise<{ project: Project }> => ipcRenderer.invoke('geo:project-update', id, input),
  selectProject: (id: string): Promise<{ project: Project; currentProject: Project }> => ipcRenderer.invoke('geo:project-select', id),
  archiveProject: (id: string): Promise<{ projects: Project[]; currentProject: Project | null }> => ipcRenderer.invoke('geo:project-archive', id),
  deleteProject: (id: string): Promise<{ projects: Project[]; currentProject: Project | null }> => ipcRenderer.invoke('geo:project-delete', id),
  exportProject: (id: string): Promise<{ canceled: boolean; filePath?: string }> => ipcRenderer.invoke('geo:project-export', id),
  importProject: (): Promise<{ canceled: boolean; project: Project | null; currentProject: Project | null }> => ipcRenderer.invoke('geo:project-import'),
  workBuddyStatus: (): Promise<WorkBuddyIntegrationStatus> => ipcRenderer.invoke('geo:workbuddy-status'),
  connectWorkBuddy: (): Promise<WorkBuddyIntegrationStatus & { prompt: string }> => ipcRenderer.invoke('geo:workbuddy-connect'),
  organizeMaterialsWithWorkBuddy: (): Promise<WorkBuddyIntegrationStatus & { prompt: string }> => ipcRenderer.invoke('geo:workbuddy-organize-materials'),
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('geo:update-status'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('geo:update-check'),
  installUpdate: (): Promise<{ accepted: boolean; message: string }> => ipcRenderer.invoke('geo:update-install'),
  setUiOverlayOpen: (open: boolean): Promise<void> => ipcRenderer.invoke('geo:ui-overlay', open),
  activateBeta: (code: string): Promise<BetaActivationResult> => ipcRenderer.invoke('geo:beta-activate', code),
  deactivateBeta: (): Promise<BetaActivationResult> => ipcRenderer.invoke('geo:beta-deactivate'),
  launchAtLoginStatus: (): Promise<LaunchAtLoginStatus> => ipcRenderer.invoke('geo:launch-at-login-status'),
  setLaunchAtLogin: (enabled: boolean): Promise<LaunchAtLoginStatus> => ipcRenderer.invoke('geo:set-launch-at-login', enabled),
  copyDiagnostics: (): Promise<{ copied: true; diagnostic: DiagnosticSummary }> => ipcRenderer.invoke('geo:copy-diagnostics'),
  copyText: (text: string): Promise<{ copied: true }> => ipcRenderer.invoke('geo:copy-text', text),
  openDataDirectory: (): Promise<{ opened: boolean; error?: string }> => ipcRenderer.invoke('geo:open-data-directory'),
  onUpdateStatus: (listener: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on('geo:update-status-changed', handler);
    return () => ipcRenderer.removeListener('geo:update-status-changed', handler);
  },
  onAttentionRequired: (listener: (attention: DesktopStatus['attentionRequired']) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, attention: DesktopStatus['attentionRequired']) => listener(attention);
    ipcRenderer.on('geo:attention-required', handler);
    return () => ipcRenderer.removeListener('geo:attention-required', handler);
  },
  onStatusChanged: (listener: (status: DesktopStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopStatus) => listener(status);
    ipcRenderer.on('geo:status-changed', handler);
    return () => ipcRenderer.removeListener('geo:status-changed', handler);
  },
  onDataChanged: (listener: (change: DataChangeEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, change: DataChangeEvent) => listener(change);
    ipcRenderer.on('geo:data-changed', handler);
    return () => ipcRenderer.removeListener('geo:data-changed', handler);
  },
});
