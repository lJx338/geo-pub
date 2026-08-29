import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import packageJson from '../../package.json' with { type: 'json' };
import type { ControlRequest, Platform } from '../shared/protocol.js';
import { loadOrCreateControlToken } from './auth.js';
import { installBundledCli } from './cli-installer.js';
import { ControlServer } from './control-server.js';
import { createDiscoveryRecord, writeDiscoveryRecord } from './discovery.js';
import { reportError } from './logging.js';
import { dataDirectory } from './runtime-paths.js';
import { UpdateManager } from './update-manager.js';
import { prepareWorkBuddyIntegration, workBuddyIntegrationStatus } from './workbuddy-integration.js';
import { BrowserWorkerClient } from './browser-worker-client.js';
import { reportWorkerStartupFailure, runBrowserWorker } from './browser-worker.js';

app.setName('GEO Publisher');
const isBrowserWorker = process.argv.includes('--browser-worker');
app.setPath('userData', isBrowserWorker ? dataDirectory() : join(dataDirectory(), 'ui-profile'));

async function runDesktop(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  const cliPath = await installBundledCli(packageJson.version).catch((error) => {
    reportError('Failed to install bundled CLI:', error);
    return null;
  });

  if (process.platform === 'win32') Menu.setApplicationMenu(null);

  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: 'GEO Publisher',
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
  const worker = new BrowserWorkerClient(packageJson.version);
  await worker.start();
  const updateManager = new UpdateManager(packageJson.version, () => worker.isBusy(), (status) => {
    if (!window.isDestroyed()) window.webContents.send('geo:update-status-changed', status);
  });
  app.on('second-instance', () => { window.show(); });

  const route = async (request: ControlRequest): Promise<unknown> => {
    if (request.action === 'status') return { ...(await worker.status()), cliPath, worker: worker.workerHealth() };
    if (request.action === 'app.show') {
      window.show();
      return { ...(await worker.status()), cliPath, worker: worker.workerHealth() };
    }
    if (request.action === 'platform.open') return await worker.open(request.platform);
    if (request.action === 'platform.inspect') return await worker.inspect(request.platform);
    if (request.action === 'draft.fill') {
      return await worker.fillDraft(request);
    }
    if (request.action === 'draft.publish') {
      return await worker.publishDraft(request);
    }
    throw new Error('不支持的控制命令');
  };

  const controlServer = new ControlServer(await loadOrCreateControlToken(), route);
  await controlServer.start();
  await writeDiscoveryRecord(createDiscoveryRecord(packageJson.version, cliPath, true));

  ipcMain.handle('geo:status', async () => ({ ...(await worker.status()), cliPath, worker: worker.workerHealth() }));
  ipcMain.handle('geo:open-platform', (_event, platform: Platform) => worker.open(platform));
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
      worker.stop(),
      controlServer.stop(),
      writeDiscoveryRecord(createDiscoveryRecord(packageJson.version, cliPath, false)),
    ])
      .finally(() => app.quit());
  });
}

if (isBrowserWorker) {
  runBrowserWorker(packageJson.version).catch((error) => {
    reportWorkerStartupFailure(error);
    process.exitCode = 1;
    app.quit();
  });
} else {
  runDesktop().catch((error) => {
    reportError('GEO Publisher failed to start:', error);
    process.exitCode = 1;
    app.quit();
  });
}
