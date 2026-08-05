import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, Tray } from 'electron';
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
  if (process.platform === 'win32') Menu.setApplicationMenu(null);

  const startsInBackground = process.argv.includes('--background') || app.getLoginItemSettings().wasOpenedAsHidden;
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: 'GEO Publisher',
    show: !startsInBackground,
    autoHideMenuBar: process.platform === 'win32',
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
  if (process.platform === 'win32') window.setMenuBarVisibility(false);
  const showWindow = () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const sessions = new PlatformSessions(window, packageJson.version, (attention) => {
    if (!window.isDestroyed()) window.webContents.send('geo:attention-required', attention);
  });
  const updateManager = new UpdateManager(packageJson.version, () => sessions.isBusy(), (status) => {
    if (!window.isDestroyed()) window.webContents.send('geo:update-status-changed', status);
  });
  window.on('resize', () => sessions.resize());
  let shuttingDown = false;
  const tray = new Tray(nativeImage.createFromPath(join(__dirname, '..', 'renderer', 'logo.png')));
  tray.setToolTip('GEO Publisher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 GEO Publisher', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
  app.on('second-instance', (_event, commandLine) => {
    if (!commandLine.includes('--background')) showWindow();
  });
  window.on('close', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    window.hide();
  });

  const route = async (request: ControlRequest): Promise<unknown> => {
    if (request.action === 'status') return { ...sessions.status(), cliPath };
    if (request.action === 'app.show') {
      showWindow();
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
  ipcMain.handle('geo:launch-at-login-status', () => ({ available: app.isPackaged, enabled: app.isPackaged && app.getLoginItemSettings().openAtLogin }));
  ipcMain.handle('geo:set-launch-at-login', (_event, enabled: boolean) => {
    if (!app.isPackaged) return { available: false, enabled: false };
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: Boolean(enabled), args: ['--background'] });
    return { available: true, enabled: app.getLoginItemSettings().openAtLogin };
  });
  await window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  if (!startsInBackground) showWindow();
  updateManager.start();
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    updateManager.stop();
    void Promise.all([
      sessions.flushStorage(),
      controlServer.stop(),
      writeDiscoveryRecord(createDiscoveryRecord(packageJson.version, cliPath, false)),
    ])
      .finally(() => {
        sessions.dispose();
        tray.destroy();
        app.quit();
      });
  });
}

runDesktop().catch((error) => {
  console.error('GEO Publisher failed to start:', error);
  process.exitCode = 1;
  app.quit();
});
