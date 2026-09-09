import type { DesktopStatus, Platform, PlatformStatus, UpdateStatus, WorkBuddyIntegrationStatus } from '../shared/protocol.js';

declare global {
  interface Window {
    geoPublisher: {
      status(): Promise<DesktopStatus>;
      showWorker(): Promise<DesktopStatus>;
      openPlatform(platform: Platform): Promise<PlatformStatus>;
      workBuddyStatus(): Promise<WorkBuddyIntegrationStatus>;
      connectWorkBuddy(): Promise<WorkBuddyIntegrationStatus & { prompt: string }>;
      updateStatus(): Promise<UpdateStatus>;
      checkForUpdates(): Promise<UpdateStatus>;
      installUpdate(): Promise<{ accepted: boolean; message: string }>;
      clearTaskHistory(): Promise<DesktopStatus>;
      openEvidence(path: string): Promise<{ opened: boolean; message?: string }>;
      exportDiagnostic(taskId: string): Promise<{ exported: boolean; path?: string; message?: string }>;
      onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
    };
  }
}

export {};
