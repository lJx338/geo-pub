import type { BetaActivationResult, DataChangeEvent, DesktopDistributionRequest, DiagnosticSummary, DesktopStatus, LaunchAtLoginStatus, Platform, PlatformStatus, UpdateStatus, WorkBuddyIntegrationStatus } from '../shared/protocol.js';
import type { Project, ProjectInput } from '../main/project-store.js';
import type { ContentFilter, ContentInput, ContentItem, ContentKind } from '../main/content-store.js';
import type { ContentRepairNotice } from '../main/content-repair.js';

declare global {
  interface Window {
    lingxiStartupBridge?: {
      ready(): void;
      failed(code: string, message: string): void;
      copy(): Promise<boolean>;
    };
    lingxiStartup: {
      ready(): void;
      fail(code: string, error: unknown): void;
    };
    geoPublisher: {
      appName: string;
      status(): Promise<DesktopStatus>;
      openPlatform(platform: Platform): Promise<PlatformStatus>;
      hidePlatform(): Promise<DesktopStatus>;
      platformBack(): Promise<DesktopStatus>;
      platformForward(): Promise<DesktopStatus>;
      platformReload(): Promise<DesktopStatus>;
      platformReopen(): Promise<DesktopStatus>;
      platformZoom(action: 'out' | 'in' | 'reset'): Promise<DesktopStatus>;
      chooseDistributionCover(): Promise<{ canceled: boolean; filePath: string }>;
      runDistribution(input: DesktopDistributionRequest): Promise<{ records: ContentItem[] }>;
      projects(): Promise<{ projects: Project[]; currentProject: Project | null }>;
      workspaceSnapshot(): Promise<{ revision: number; projects: Project[]; currentProject: Project | null; items: ContentItem[]; contentCounts: Record<string, number>; contentRepair: ContentRepairNotice | null }>;
      dataRevision(): Promise<number>;
      contentList(projectId: string, kind?: ContentKind, filter?: ContentFilter): Promise<{ items: ContentItem[] }>;
      contentSave(projectId: string, input: ContentInput): Promise<{ item: ContentItem }>;
      contentDelete(projectId: string, itemId: string): Promise<{ item: ContentItem }>;
      contentImportMaterial(projectId: string, sourcePath: string, input?: Omit<ContentInput, 'kind'>): Promise<{ item: ContentItem }>;
      contentChooseMaterial(projectId: string): Promise<{ canceled: boolean; items: ContentItem[] }>;
      materialThumbnail(projectId: string, materialId: string): Promise<{ dataUrl: string; width: number; height: number }>;
      topicVariant(projectId: string, topicId: string, input: ContentInput): Promise<{ item: ContentItem }>;
      createProject(input: ProjectInput): Promise<{ project: Project; currentProject: Project }>;
      updateProject(id: string, input: Partial<ProjectInput>): Promise<{ project: Project }>;
      selectProject(id: string): Promise<{ project: Project; currentProject: Project }>;
      archiveProject(id: string): Promise<{ projects: Project[]; currentProject: Project | null }>;
      deleteProject(id: string): Promise<{ projects: Project[]; currentProject: Project | null }>;
      exportProject(id: string): Promise<{ canceled: boolean; filePath?: string }>;
      importProject(): Promise<{ canceled: boolean; project: Project | null; currentProject: Project | null }>;
      workBuddyStatus(): Promise<WorkBuddyIntegrationStatus>;
      connectWorkBuddy(): Promise<WorkBuddyIntegrationStatus & { prompt: string }>;
      organizeMaterialsWithWorkBuddy(): Promise<WorkBuddyIntegrationStatus & { prompt: string }>;
      updateStatus(): Promise<UpdateStatus>;
      checkForUpdates(): Promise<UpdateStatus>;
      installUpdate(): Promise<{ accepted: boolean; message: string }>;
      setUiOverlayOpen(open: boolean): Promise<void>;
      activateBeta(code: string): Promise<BetaActivationResult>;
      deactivateBeta(): Promise<BetaActivationResult>;
      launchAtLoginStatus(): Promise<LaunchAtLoginStatus>;
      setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginStatus>;
      openLaunchAtLoginSettings(): Promise<{ opened: true }>;
      copyDiagnostics(): Promise<{ copied: true; diagnostic: DiagnosticSummary }>;
      exportDiagnosticLogs(): Promise<{ exported: boolean; path?: string; message?: string }>;
      exportDiagnostic(projectId: string, recordId: string): Promise<{ exported: boolean; path?: string; message?: string }>;
      copyText(text: string): Promise<{ copied: true }>;
      openDataDirectory(): Promise<{ opened: boolean; error?: string }>;
      openContentBackups(): Promise<{ opened: boolean; error?: string }>;
      onContentRepair(listener: (notice: ContentRepairNotice) => void): () => void;
      onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
      onAttentionRequired(listener: (attention: DesktopStatus['attentionRequired']) => void): () => void;
      onStatusChanged(listener: (status: DesktopStatus) => void): () => void;
      onDataChanged(listener: (change: DataChangeEvent) => void): () => void;
    };
  }
}

export {};
