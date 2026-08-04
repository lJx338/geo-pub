import type { DesktopStatus, Platform, PlatformStatus } from '../shared/protocol.js';

declare global {
  interface Window {
    geoPublisher: {
      status(): Promise<DesktopStatus>;
      openPlatform(platform: Platform): Promise<PlatformStatus>;
    };
  }
}

export {};
