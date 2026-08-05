import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import packageJson from '../../package.json' with { type: 'json' };
import type { ControlRequest, Platform } from '../shared/protocol.js';
import { loadOrCreateControlToken } from './auth.js';
import { installBundledCli } from './cli-installer.js';
import { ControlServer } from './control-server.js';
import { createDiscoveryRecord, writeDiscoveryRecord } from './discovery.js';
import { PlatformSessions } from './platform-sessions.js';
import { dataDirectory } from './runtime-paths.js';
import { setupStealthSession } from './stealth.js';
import { UpdateManager } from './update-manager.js';
import { prepareWorkBuddyIntegration, workBuddyIntegrationStatus } from './workbuddy-integration.js';

app.setName('GEO Publisher');
app.setPath('userData', dataDirectory());

async function runDesktop(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  const cliPath = await installBundledCli(packageJson.version).catch((error) => {
    console.error('Failed to install bundled CLI:', error);
    return null;
  });

  // 为默认session配置反检测
  setupStealthSession(session.defaultSession);

  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: 'GEO Publisher',
    icon: join(__dirname, '..', 'renderer', 'logo.png'),
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const sessions = new PlatformSessions(window, packageJson.version);
  const updateManager = new UpdateManager(packageJson.version, () => sessions.isBusy(), (status) => {
    if (!window.isDestroyed()) window.webContents.send('geo:update-status-changed', status);
  });
  window.on('resize', () => sessions.resize());
  app.on('second-instance', () => { window.show(); });

  const route = async (request: ControlRequest): Promise<unknown> => {
    if (request.action === 'status') return { ...sessions.status(), cliPath };
    if (request.action === 'app.show') {
      window.show();
      return { ...sessions.status(), cliPath };
    }
    if (request.action === 'platform.open') return await sessions.open(request.platform);
    if (request.action === 'platform.inspect') return await sessions.inspect(request.platform);
    if (request.action === 'draft.fill') {
      return await sessions.fillDraft(request.platform, request.title, request.html, request.coverPath, request.tags);
    }
    if (request.action === 'draft.publish') {
      return await sessions.publishDraft(request.platform, request.title, request.html, request.coverPath, request.tags);
    }
    throw new Error('不支持的控制命令');
  };

  const controlServer = new ControlServer(await loadOrCreateControlToken(), route);
  await controlServer.start();
  await writeDiscoveryRecord(createDiscoveryRecord(packageJson.version, cliPath, true));

  ipcMain.handle('geo:status', () => ({ ...sessions.status(), cliPath }));
  ipcMain.handle('geo:open-platform', (_event, platform: Platform) => sessions.open(platform));
  ipcMain.handle('geo:workbuddy-status', () => workBuddyIntegrationStatus());
  ipcMain.handle('geo:workbuddy-connect', () => prepareWorkBuddyIntegration(true, cliPath));
  ipcMain.handle('geo:update-status', () => updateManager.getStatus());
  ipcMain.handle('geo:update-check', () => updateManager.check());
  ipcMain.handle('geo:update-install', () => updateManager.install());
  await window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  updateManager.start();
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    updateManager.stop();
    void Promise.all([
      sessions.flushStorage(),
      controlServer.stop(),
      writeDiscoveryRecord(createDiscoveryRecord(packageJson.version, cliPath, false)),
    ])
      .finally(() => app.quit());
  });
}

runDesktop().catch((error) => {
  console.error('GEO Publisher failed to start:', error);
  process.exitCode = 1;
  app.quit();
});
