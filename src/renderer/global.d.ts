import type { BetaActivationResult, DesktopStatus, LaunchAtLoginStatus, Platform, PlatformStatus, UpdateStatus, WorkBuddyIntegrationStatus } from '../shared/protocol.js';

declare global {
  interface Window {
    geoPublisher: {
      status(): Promise<DesktopStatus>;
      openPlatform(platform: Platform): Promise<PlatformStatus>;
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
    };
  }
}

export {};
