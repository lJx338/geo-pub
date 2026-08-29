import { app, BrowserWindow, Menu, powerSaveBlocker, session } from 'electron';
import { PLATFORMS, type Platform } from '../shared/protocol.js';
import type { BrowserWorkerRequest } from './browser-worker-protocol.js';
import {
  BROWSER_WORKER_ENDPOINT_ENV,
  BROWSER_WORKER_APP_VERSION_ENV,
  BROWSER_WORKER_PROTOCOL_ENV,
  BROWSER_WORKER_PROTOCOL_VERSION,
  BROWSER_WORKER_TOKEN_ENV,
} from './browser-worker-protocol.js';
import { BrowserWorkerServer } from './browser-worker-server.js';
import { reportError } from './logging.js';
import { PlatformSessions } from './platform-sessions.js';
import { runResourceMaintenance } from './resource-maintenance.js';
import { setupStealthSession } from './stealth.js';

function environment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`WORKER_CONFIGURATION_INVALID: 缺少 ${name}`);
  return value;
}

export async function runBrowserWorker(version: string): Promise<void> {
  const endpoint = environment(BROWSER_WORKER_ENDPOINT_ENV);
  const token = environment(BROWSER_WORKER_TOKEN_ENV);
  const appVersion = environment(BROWSER_WORKER_APP_VERSION_ENV);
  const protocolVersion = Number(environment(BROWSER_WORKER_PROTOCOL_ENV));
  if (protocolVersion !== BROWSER_WORKER_PROTOCOL_VERSION) {
    throw new Error(`WORKER_PROTOCOL_MISMATCH: expected=${BROWSER_WORKER_PROTOCOL_VERSION}, received=${protocolVersion}`);
  }

  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  await app.whenReady();
  if (process.platform === 'darwin') app.dock?.hide();
  if (process.platform === 'win32') Menu.setApplicationMenu(null);
  setupStealthSession(session.defaultSession);

  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    title: 'GEO Publisher Browser Worker',
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.on('close', (event) => {
    event.preventDefault();
    window.hide();
  });
  const sessions = new PlatformSessions(window, version, { layout: 'execution' });
  let lastMaintenanceAt = 0;
  const runMaintenance = async (): Promise<void> => {
    if (sessions.isBusy()) return;
    try {
      const result = await runResourceMaintenance(PLATFORMS.map((platform) => session.fromPartition(`persist:geo-publisher-${platform}`)));
      lastMaintenanceAt = Date.parse(result.ranAt);
      sessions.setResourceMaintenance({
        evidenceBytes: result.evidenceBytes,
        cacheBytes: result.cacheBytes,
        lastMaintenanceAt: result.ranAt,
      });
    } catch (error) {
      reportError('Resource maintenance failed:', error);
    }
  };
  void runMaintenance();
  const maintenanceTimer = setInterval(() => {
    if (Date.now() - lastMaintenanceAt >= 24 * 60 * 60 * 1000) void runMaintenance();
  }, 30 * 60 * 1000);
  let powerBlockerId: number | null = null;
  let powerProtectionCount = 0;
  const withPowerProtection = async <T>(operation: () => Promise<T>): Promise<T> => {
    powerProtectionCount += 1;
    if (powerProtectionCount === 1) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    try {
      return await operation();
    } finally {
      powerProtectionCount -= 1;
      if (powerProtectionCount === 0) {
        if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
        powerBlockerId = null;
      }
    }
  };

  let server: BrowserWorkerServer;
  server = new BrowserWorkerServer(endpoint, token, appVersion, async (request: BrowserWorkerRequest) => {
    if (request.action === 'status') {
      return {
        ...sessions.status(),
        worker: { state: 'ready', pid: process.pid, protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, lastError: null },
      };
    }
    if (request.action === 'platform.open') return await sessions.open(requiredPlatform(request), 'interactive');
    if (request.action === 'platform.inspect') return await sessions.inspect(requiredPlatform(request));
    if (request.action === 'draft.fill') return await withPowerProtection(() => sessions.fillDraft(...articleArgs(request)));
    if (request.action === 'draft.publish') return await withPowerProtection(() => sessions.publishDraft(...articleArgs(request)));
    if (request.action === 'shutdown') {
      clearInterval(maintenanceTimer);
      await sessions.dispose();
      setTimeout(() => app.exit(0), 0);
      return { stopping: true };
    }
    throw new Error(`WORKER_UNSUPPORTED_ACTION: ${request.action}`);
  });
  try {
    await server.start();
  } catch (error) {
    await sessions.dispose();
    throw error;
  }
  app.on('before-quit', () => {
    clearInterval(maintenanceTimer);
    void sessions.dispose();
    void server.stop();
  });
}

function requiredPlatform(request: BrowserWorkerRequest): Platform {
  const platform = request.payload?.platform;
  if (!platform) throw new Error('WORKER_INVALID_REQUEST: 缺少 platform');
  return platform;
}

function articleArgs(request: BrowserWorkerRequest): [Platform, string, string, string, string[]] {
  const { platform, title, html, coverPath, tags } = request.payload || {};
  if (!platform || typeof title !== 'string' || typeof html !== 'string' || typeof coverPath !== 'string' || !Array.isArray(tags)) {
    throw new Error('WORKER_INVALID_REQUEST: 发布请求字段不完整');
  }
  return [platform, title, html, coverPath, tags];
}

export function reportWorkerStartupFailure(error: unknown): void {
  reportError('GEO Publisher Browser Worker failed to start:', error);
}
