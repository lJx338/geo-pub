import type { BetaActivationResult, DesktopStatus, LaunchAtLoginStatus, Platform, PlatformStatus, UpdateStatus, WorkBuddyIntegrationStatus } from '../shared/protocol.js';
import type { Project, ProjectInput } from '../main/project-store.js';

declare global {
  interface Window {
    geoPublisher: {
      status(): Promise<DesktopStatus>;
      openPlatform(platform: Platform): Promise<PlatformStatus>;
      projects(): Promise<{ projects: Project[]; currentProject: Project | null }>;
      createProject(input: ProjectInput): Promise<{ project: Project; currentProject: Project }>;
      updateProject(id: string, input: Partial<ProjectInput>): Promise<{ project: Project }>;
      selectProject(id: string): Promise<{ project: Project; currentProject: Project }>;
      archiveProject(id: string): Promise<{ projects: Project[]; currentProject: Project | null }>;
      exportProject(id: string): Promise<{ canceled: boolean; filePath?: string }>;
      importProject(): Promise<{ canceled: boolean; project: Project | null; currentProject: Project | null }>;
      workBuddyStatus(): Promise<WorkBuddyIntegrationStatus>;
      connectWorkBuddy(): Promise<WorkBuddyIntegrationStatus & { prompt: string }>;
      updateStatus(): Promise<UpdateStatus>;
      checkForUpdates(): Promise<UpdateStatus>;
      installUpdate(): Promise<{ accepted: boolean; message: string }>;
      setUiOverlayOpen(open: boolean): Promise<void>;
      activateBeta(code: string): Promise<BetaActivationResult>;
      deactivateBeta(): Promise<BetaActivationResult>;
      launchAtLoginStatus(): Promise<LaunchAtLoginStatus>;
      setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginStatus>;
      onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
      onAttentionRequired(listener: (attention: DesktopStatus['attentionRequired']) => void): () => void;
      onStatusChanged(listener: (status: DesktopStatus) => void): () => void;
    };
  }
}

export {};
