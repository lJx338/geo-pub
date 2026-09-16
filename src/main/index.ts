import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import packageJson from '../../package.json' with { type: 'json' };
import type { ControlRequest, Platform } from '../shared/protocol.js';
import { loadOrCreateControlToken } from './auth.js';
import { installBundledCli } from './cli-installer.js';
import { ControlServer } from './control-server.js';
import { createDiscoveryRecord, writeDiscoveryRecord } from './discovery.js';
import { reportError } from './logging.js';
import { dataDirectory, evidenceDirectory } from './runtime-paths.js';
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
  const installedCli = await installBundledCli(packageJson.version).catch((error) => {
    reportError('Failed to install bundled CLI:', error);
    return null;
  });
  const cliPaths = installedCli || { launcherPath: null, coreCliPath: null };
  const cliPath = cliPaths.launcherPath;

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
  await writeDiscoveryRecord(createDiscoveryRecord(packageJson.version, cliPaths, true));
  // Keep the on-disk Skill current after desktop updates. A running WorkBuddy
  // conversation still needs a fresh doctor/instructions handshake.
  if (cliPath) {
    await prepareWorkBuddyIntegration(false, cliPath).catch((error) => {
      reportError('Failed to refresh WorkBuddy integration:', error);
    });
  }

  ipcMain.handle('geo:status', async () => ({ ...(await worker.status()), cliPath, worker: worker.workerHealth() }));
  ipcMain.handle('geo:show-worker', () => worker.show());
  ipcMain.handle('geo:open-platform', (_event, platform: Platform) => worker.open(platform));
  ipcMain.handle('geo:workbuddy-status', () => workBuddyIntegrationStatus());
  ipcMain.handle('geo:workbuddy-connect', () => prepareWorkBuddyIntegration(true, cliPath));
  ipcMain.handle('geo:update-status', () => updateManager.getStatus());
  ipcMain.handle('geo:update-check', () => updateManager.check());
  ipcMain.handle('geo:update-install', () => updateManager.install());
  ipcMain.handle('geo:history-clear', () => worker.clearTaskHistory());
  ipcMain.handle('geo:evidence-open', async (_event, candidate: unknown) => {
    if (typeof candidate !== 'string') return { opened: false, message: '证据路径无效' };
    const path = resolve(candidate);
    const root = `${resolve(evidenceDirectory())}${sep}`;
    if (!path.startsWith(root)) return { opened: false, message: '只能打开本地失败画面' };
    const error = await shell.openPath(path);
    return error ? { opened: false, message: error } : { opened: true };
  });
  ipcMain.handle('geo:diagnostic-export', async (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') return { exported: false, message: '诊断任务编号无效' };
    const bundle = await worker.exportDiagnostic(taskId);
    const source = resolve(bundle.path);
    const temporaryRoot = `${resolve(join(tmpdir(), 'geo-publisher-diagnostic-exports'))}${sep}`;
    if (!source.startsWith(temporaryRoot) || !source.toLowerCase().endsWith('.zip')) {
      return { exported: false, message: '诊断包路径无效' };
    }
    const choice = await dialog.showSaveDialog(window, {
      title: '保存诊断包',
      defaultPath: join(app.getPath('downloads'), bundle.fileName),
      filters: [{ name: 'ZIP 诊断包', extensions: ['zip'] }],
    });
    if (choice.canceled || !choice.filePath) {
      await rm(source, { force: true }).catch(() => undefined);
      return { exported: false, message: '已取消保存' };
    }
    await copyFile(source, choice.filePath);
    await rm(source, { force: true }).catch(() => undefined);
    shell.showItemInFolder(choice.filePath);
    return { exported: true, path: choice.filePath };
  });
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
      writeDiscoveryRecord(createDiscoveryRecord(packageJson.version, cliPaths, false)),
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
