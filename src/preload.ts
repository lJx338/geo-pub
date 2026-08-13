import { contextBridge, ipcRenderer } from 'electron';
import type { BetaActivationResult, DesktopStatus, LaunchAtLoginStatus, Platform, PlatformStatus, UpdateStatus, WorkBuddyIntegrationStatus } from './shared/protocol.js';
import type { Project, ProjectInput } from './main/project-store.js';

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
  projects: (): Promise<{ projects: Project[]; currentProject: Project | null }> => ipcRenderer.invoke('geo:projects-list'),
  createProject: (input: ProjectInput): Promise<{ project: Project; currentProject: Project }> => ipcRenderer.invoke('geo:project-create', input),
  updateProject: (id: string, input: Partial<ProjectInput>): Promise<{ project: Project }> => ipcRenderer.invoke('geo:project-update', id, input),
  selectProject: (id: string): Promise<{ project: Project; currentProject: Project }> => ipcRenderer.invoke('geo:project-select', id),
  workBuddyStatus: (): Promise<WorkBuddyIntegrationStatus> => ipcRenderer.invoke('geo:workbuddy-status'),
  connectWorkBuddy: (): Promise<WorkBuddyIntegrationStatus & { prompt: string }> => ipcRenderer.invoke('geo:workbuddy-connect'),
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('geo:update-status'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('geo:update-check'),
  installUpdate: (): Promise<{ accepted: boolean; message: string }> => ipcRenderer.invoke('geo:update-install'),
  setUiOverlayOpen: (open: boolean): Promise<void> => ipcRenderer.invoke('geo:ui-overlay', open),
  activateBeta: (code: string): Promise<BetaActivationResult> => ipcRenderer.invoke('geo:beta-activate', code),
  deactivateBeta: (): Promise<BetaActivationResult> => ipcRenderer.invoke('geo:beta-deactivate'),
  launchAtLoginStatus: (): Promise<LaunchAtLoginStatus> => ipcRenderer.invoke('geo:launch-at-login-status'),
  setLaunchAtLogin: (enabled: boolean): Promise<LaunchAtLoginStatus> => ipcRenderer.invoke('geo:set-launch-at-login', enabled),
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
});
