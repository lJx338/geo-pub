import { app, BrowserWindow, ipcMain, Menu, powerSaveBlocker, screen, session } from 'electron';
import { join } from 'node:path';
import { PLATFORMS, type Platform, type PlatformStatus } from '../shared/protocol.js';
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
import { constrainWorkerWindowToWorkArea, fitWorkerWindowToWorkArea } from './worker-window-layout.js';
import { concealWorkerWindow } from './worker-window-visibility.js';

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

  const initialBounds = fitWorkerWindowToWorkArea(screen.getPrimaryDisplay().workArea);
  const window = new BrowserWindow({
    ...initialBounds,
    show: false,
    title: 'GEO Publisher Browser Worker',
    // A hidden window does not occupy the Windows taskbar. Keeping the native
    // taskbar style allows an explicit user show request to surface reliably.
    skipTaskbar: process.platform !== 'win32',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: join(__dirname, '..', 'worker-tabs-preload.cjs'),
    },
  });
  const fitWindowToCurrentDisplay = (): void => {
    if (window.isDestroyed()) return;
    const display = screen.getDisplayMatching(window.getBounds());
    const next = constrainWorkerWindowToWorkArea(window.getBounds(), display.workArea);
    const current = window.getBounds();
    if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height) {
      window.setBounds(next);
    }
  };
  window.on('move', fitWindowToCurrentDisplay);
  screen.on('display-metrics-changed', (_event, display, changedMetrics) => {
    if (changedMetrics.includes('workArea') || changedMetrics.includes('bounds') || changedMetrics.includes('scaleFactor')) {
      const currentDisplay = screen.getDisplayMatching(window.getBounds());
      if (currentDisplay.id === display.id) fitWindowToCurrentDisplay();
    }
  });
  screen.on('display-added', fitWindowToCurrentDisplay);
  screen.on('display-removed', fitWindowToCurrentDisplay);
  window.on('close', (event) => {
    event.preventDefault();
    concealWorkerWindow(window, process.platform === 'win32');
  });
  const sessions = new PlatformSessions(window, version, { layout: 'execution', tabBarHeight: 48 });
  await sessions.loadTaskHistory();
  window.on('hide', () => sessions.scheduleIdleViewDisposal());
  window.on('show', () => sessions.cancelIdleViewDisposal());
  window.on('resize', () => sessions.resize());
  const publishTabStatus = (): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('worker-tabs-status', sessions.status());
    }
  };
  let platformSwitchTail: Promise<void> = Promise.resolve();
  const queuePlatformOpen = async (platform: Platform): Promise<PlatformStatus> => {
    if (!PLATFORMS.includes(platform)) throw new Error('WORKER_PLATFORM_INVALID: 不支持的平台');
    const operation = platformSwitchTail.then(async () => {
      const opening = sessions.open(platform, 'interactive');
      publishTabStatus();
      try {
        return await opening;
      } finally {
        publishTabStatus();
      }
    });
    platformSwitchTail = operation.then(() => undefined, () => undefined);
    return await operation;
  };
  ipcMain.handle('worker-tabs-select-platform', async (_event, platform: Platform) => {
    await queuePlatformOpen(platform);
    return sessions.status();
  });
  ipcMain.handle('worker-tabs-status', () => sessions.status());
  await window.loadFile(join(__dirname, '..', 'worker-tabs', 'index.html'));
  let lastMaintenanceAt = 0;
  const runMaintenance = async (): Promise<void> => {
    if (sessions.isBusy()) return;
    try {
      const platformSessions = new Map(PLATFORMS.map((platform) => [platform, session.fromPartition(`persist:geo-publisher-${platform}`)]));
      const activePlatform = sessions.status().activePlatform;
      const protectedSession = window.isVisible() && activePlatform ? platformSessions.get(activePlatform) ?? null : null;
      const result = await runResourceMaintenance([...platformSessions.values()], protectedSession);
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
    if (request.action === 'worker.show') {
      fitWindowToCurrentDisplay();
      sessions.showWindow();
      if (!window.isVisible()) {
        throw new Error('WORKER_WINDOW_SHOW_FAILED: Windows 未确认发布窗口已显示');
      }
      publishTabStatus();
      return sessions.status();
    }
    if (request.action === 'history.clear') {
      await sessions.clearCompletedTaskHistory();
      publishTabStatus();
      return sessions.status();
    }
    if (request.action === 'diagnostic.export') {
      const taskId = request.payload?.taskId;
      if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(taskId)) {
        throw new Error('DIAGNOSTIC_TASK_INVALID: 诊断任务编号无效');
      }
      return await sessions.exportTaskDiagnostic(taskId);
    }
    if (request.action === 'platform.open') {
      return await queuePlatformOpen(requiredPlatform(request));
    }
    if (request.action === 'platform.inspect') {
      const operation = sessions.inspect(requiredPlatform(request));
      publishTabStatus();
      try {
        return await operation;
      } finally {
        publishTabStatus();
      }
    }
    if (request.action === 'draft.fill') {
      const operation = withPowerProtection(() => sessions.fillDraft(...articleArgs(request)));
      publishTabStatus();
      try {
        return await operation;
      } finally {
        publishTabStatus();
      }
    }
    if (request.action === 'draft.publish') {
      const operation = withPowerProtection(() => sessions.publishDraft(...articleArgs(request)));
      publishTabStatus();
      try {
        return await operation;
      } finally {
        publishTabStatus();
      }
    }
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

function articleArgs(request: BrowserWorkerRequest): [Platform, string, string, string, string[], string | undefined] {
  const { platform, title, html, coverPath, tags, operationId } = request.payload || {};
  if (!platform || typeof title !== 'string' || typeof html !== 'string' || typeof coverPath !== 'string' || !Array.isArray(tags)) {
    throw new Error('WORKER_INVALID_REQUEST: 发布请求字段不完整');
  }
  if (operationId !== undefined && (typeof operationId !== 'string' || operationId.trim().length < 8 || operationId.length > 128)) {
    throw new Error('WORKER_INVALID_REQUEST: operationId 无效');
  }
  return [platform, title, html, coverPath, tags, operationId?.trim() || undefined];
}

export function reportWorkerStartupFailure(error: unknown): void {
  reportError('GEO Publisher Browser Worker failed to start:', error);
}
