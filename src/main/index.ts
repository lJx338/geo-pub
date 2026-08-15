import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import packageJson from '../../package.json' with { type: 'json' };
import type { ControlRequest, DataChangeEvent, Platform } from '../shared/protocol.js';
import { loadOrCreateControlToken } from './auth.js';
import { installBundledCli } from './cli-installer.js';
import { ControlServer } from './control-server.js';
import { createDiscoveryRecord, writeDiscoveryRecord } from './discovery.js';
import { PlatformSessions } from './platform-sessions.js';
import { ProjectStore, type ProjectInput } from './project-store.js';
import { ContentStore, type ContentKind, type ContentInput, type ContentFilter } from './content-store.js';
import { DataChangeTracker } from './data-change.js';
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
  const projects = new ProjectStore();
  await projects.load();
  const content = new ContentStore();
  const dataChanges = new DataChangeTracker();
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
    paintWhenInitiallyHidden: true,
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
  let closingForUpdate = false;
  const sessions = new PlatformSessions(window, packageJson.version, (attention) => {
    if (!window.isDestroyed()) window.webContents.send('geo:attention-required', attention);
  }, () => {
    if (!window.isDestroyed()) window.webContents.send('geo:status-changed', sessions.status());
  });
  if (projects.current()) await sessions.selectProject(projects.current()!.id);
  const updateManager = new UpdateManager(packageJson.version, () => sessions.isBusy(), (status) => {
    if (status.phase === 'error') closingForUpdate = false;
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
  // Finder/Dock activation on macOS reuses the existing process instead of
  // triggering second-instance. Without this handler an app launched at login
  // with --background remains hidden when the customer clicks its icon.
  app.on('activate', showWindow);
  window.on('close', (event) => {
    // MacUpdater closes windows before it emits app.before-quit. Without this
    // explicit path, the regular "hide on close" behavior blocks installation.
    if (shuttingDown || closingForUpdate) return;
    event.preventDefault();
    window.hide();
  });

  const desktopStatus = () => ({ ...sessions.status(), cliPath, currentProject: projects.current() });
  const recordDataChange = (change: Omit<DataChangeEvent, 'revision' | 'changedAt'>) => {
    const event = dataChanges.record(change);
    if (!window.isDestroyed()) window.webContents.send('geo:data-changed', event);
    return event;
  };
  const workspaceSnapshot = async () => {
    let snapshot = { revision: dataChanges.current(), projects: projects.list(), currentProject: projects.current(), items: [] as Awaited<ReturnType<ContentStore['list']>> };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = dataChanges.current();
      const currentProject = projects.current();
      snapshot = {
        revision,
        projects: projects.list(),
        currentProject,
        items: currentProject ? await content.list(currentProject.id) : [],
      };
      if (dataChanges.current() === revision) break;
    }
    return snapshot;
  };
  const ensureCurrentContentProject = (projectId: string) => {
    const project = projects.get(projectId);
    if (!project) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    if (projects.current()?.id !== projectId) throw new Error('PROJECT_CONTEXT_CHANGED: 当前客户项目已切换，请重新读取当前项目后再操作内容');
    return project;
  };
  const route = async (request: ControlRequest): Promise<unknown> => {
    if (request.action === 'status') return desktopStatus();
    if (request.action === 'project.list') return { projects: projects.list(), currentProject: projects.current() };
    if (request.action === 'project.current') return { project: projects.current() };
    if (request.action === 'project.get') return { project: projects.get(request.projectId) };
    if (request.action === 'project.create') {
      const project = await projects.create(request.project as ProjectInput);
      await sessions.selectProject(project.id);
      recordDataChange({ entity: 'project', action: 'created', projectId: project.id, source: 'cli' });
      return { project, currentProject: project };
    }
    if (request.action === 'project.update') {
      const project = await projects.update(request.projectId, request.project as Partial<ProjectInput>);
      recordDataChange({ entity: 'project', action: 'updated', projectId: project.id, source: 'cli' });
      return { project };
    }
    if (request.action === 'project.select') {
      const project = await projects.select(request.projectId);
      await sessions.selectProject(project.id);
      recordDataChange({ entity: 'project', action: 'selected', projectId: project.id, source: 'cli' });
      return { project, currentProject: project };
    }
    if (request.action === 'project.archive') {
      if (sessions.isBusy()) throw new Error('PUBLISHER_BUSY: 发布任务运行中，暂时不能归档客户项目');
      await projects.archive(request.projectId);
      const current = projects.current();
      if (current) await sessions.selectProject(current.id);
      else await sessions.clearProject();
      recordDataChange({ entity: 'project', action: 'archived', projectId: request.projectId, source: 'cli' });
      return { currentProject: current };
    }
    if (request.action === 'content.list') {
      ensureCurrentContentProject(request.projectId);
      return { items: await content.list(request.projectId, request.kind as ContentKind | undefined, (request.filter || {}) as ContentFilter) };
    }
    if (request.action === 'content.save') {
      ensureCurrentContentProject(request.projectId);
      const item = await content.save(request.projectId, request.item as ContentInput);
      recordDataChange({ entity: 'content', action: 'saved', projectId: request.projectId, itemId: item.id, contentKind: item.kind, source: 'cli' });
      return { item };
    }
    if (request.action === 'content.import-material') {
      ensureCurrentContentProject(request.projectId);
      const item = await content.importMaterial(request.projectId, request.sourcePath, (request.item || {}) as ContentInput);
      recordDataChange({ entity: 'content', action: 'saved', projectId: request.projectId, itemId: item.id, contentKind: item.kind, source: 'cli' });
      return { item };
    }
    if (request.action === 'topic.reserve') {
      ensureCurrentContentProject(request.projectId);
      return { item: await content.reserveTopic(request.projectId, request.topicId, request.taskId, request.ttlMs) };
    }
    if (request.action === 'topic.release') {
      ensureCurrentContentProject(request.projectId);
      return { item: await content.releaseTopic(request.projectId, request.topicId, request.taskId) };
    }
    if (request.action === 'topic.use') {
      ensureCurrentContentProject(request.projectId);
      const item = await content.markTopicUsed(request.projectId, request.topicId, request.articleId, request.taskId);
      recordDataChange({ entity: 'content', action: 'saved', projectId: request.projectId, itemId: item.id, contentKind: item.kind, source: 'cli' });
      return { item };
    }
    if (request.action === 'topic.variant') {
      ensureCurrentContentProject(request.projectId);
      const item = await content.createTopicVariant(request.projectId, request.topicId, request.item as ContentInput);
      recordDataChange({ entity: 'content', action: 'saved', projectId: request.projectId, itemId: item.id, contentKind: item.kind, source: 'cli' });
      return { item };
    }
    if (request.action === 'app.show') {
      showWindow();
      return desktopStatus();
    }
    if (request.action === 'platform.open') return await sessions.open(request.platform);
    if (request.action === 'platform.inspect') return await sessions.inspect(request.platform);
    if (request.action === 'draft.fill') {
      sessions.ensureProject(request.projectId);
      return await sessions.fillDraft(request.platform, request.document, request.coverPath);
    }
    if (request.action === 'draft.publish') {
      sessions.ensureProject(request.projectId);
      return await sessions.publishDraft(request.platform, request.document, request.coverPath);
    }
    throw new Error('不支持的控制命令');
  };

  const controlServer = new ControlServer(await loadOrCreateControlToken(), route);
  await controlServer.start();
  await writeDiscoveryRecord(createDiscoveryRecord(packageJson.version, cliPath, true));

  ipcMain.handle('geo:status', desktopStatus);
  ipcMain.handle('geo:projects-list', () => ({ projects: projects.list(), currentProject: projects.current() }));
  ipcMain.handle('geo:workspace-snapshot', workspaceSnapshot);
  ipcMain.handle('geo:data-revision', () => dataChanges.current());
  ipcMain.handle('geo:content-list', async (_event, projectId: string, kind?: ContentKind, filter?: ContentFilter) => ({ items: await content.list(projectId, kind, filter) }));
  ipcMain.handle('geo:content-save', async (_event, projectId: string, input: ContentInput) => {
    const item = await content.save(projectId, input);
    recordDataChange({ entity: 'content', action: 'saved', projectId, itemId: item.id, contentKind: item.kind, source: 'desktop' });
    return { item };
  });
  ipcMain.handle('geo:content-import-material', async (_event, projectId: string, sourcePath: string, input?: Omit<ContentInput, 'kind'>) => {
    if (!projects.get(projectId)) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    const item = await content.importMaterial(projectId, sourcePath, input);
    recordDataChange({ entity: 'content', action: 'saved', projectId, itemId: item.id, contentKind: item.kind, source: 'desktop' });
    return { item };
  });
  ipcMain.handle('geo:content-choose-material', async (_event, projectId: string) => {
    if (!projects.get(projectId)) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    const selection = await dialog.showOpenDialog(window, { title: '添加客户素材', properties: ['openFile', 'multiSelections'], filters: [{ name: '常用素材', extensions: ['txt', 'md', 'pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'webp'] }, { name: '所有文件', extensions: ['*'] }] });
    if (selection.canceled) return { canceled: true, items: [] };
    const imported = [];
    for (const sourcePath of selection.filePaths) {
      const item = await content.importMaterial(projectId, sourcePath);
      imported.push(item); recordDataChange({ entity: 'content', action: 'saved', projectId, itemId: item.id, contentKind: item.kind, source: 'desktop' });
    }
    return { canceled: false, items: imported };
  });
  ipcMain.handle('geo:topic-variant', async (_event, projectId: string, topicId: string, input: ContentInput) => {
    if (!projects.get(projectId)) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    const item = await content.createTopicVariant(projectId, topicId, input);
    recordDataChange({ entity: 'content', action: 'saved', projectId, itemId: item.id, contentKind: item.kind, source: 'desktop' });
    return { item };
  });
  ipcMain.handle('geo:project-create', async (_event, input: ProjectInput) => {
    if (sessions.isBusy()) throw new Error('PUBLISHER_BUSY: 发布任务运行中，暂时不能新建客户项目');
    const project = await projects.create(input);
    await sessions.selectProject(project.id);
    recordDataChange({ entity: 'project', action: 'created', projectId: project.id, source: 'desktop' });
    return { project, currentProject: project };
  });
  ipcMain.handle('geo:project-update', async (_event, id: string, input: Partial<ProjectInput>) => {
    const project = await projects.update(id, input);
    recordDataChange({ entity: 'project', action: 'updated', projectId: project.id, source: 'desktop' });
    return { project };
  });
  ipcMain.handle('geo:project-select', async (_event, id: string) => {
    const project = await projects.select(id);
    await sessions.selectProject(project.id);
    recordDataChange({ entity: 'project', action: 'selected', projectId: project.id, source: 'desktop' });
    return { project, currentProject: project };
  });
  ipcMain.handle('geo:project-archive', async (_event, id: string) => {
    if (sessions.isBusy()) throw new Error('PUBLISHER_BUSY: 发布任务运行中，暂时不能归档客户项目');
    await projects.archive(id);
    const current = projects.current();
    if (current) await sessions.selectProject(current.id);
    else await sessions.clearProject();
    recordDataChange({ entity: 'project', action: 'archived', projectId: id, source: 'desktop' });
    return { projects: projects.list(), currentProject: current };
  });
  ipcMain.handle('geo:project-export', async (_event, id: string) => {
    const project = projects.get(id);
    if (!project || project.archivedAt) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    const result = await dialog.showSaveDialog(window, {
      title: '导出客户项目资料',
      defaultPath: `${project.name}-项目资料.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeFile(result.filePath, `${JSON.stringify(projects.export(id), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('geo:project-import', async () => {
    if (sessions.isBusy()) throw new Error('PUBLISHER_BUSY: 发布任务运行中，暂时不能导入客户项目');
    const result = await dialog.showOpenDialog(window, {
      title: '导入客户项目资料',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, project: null, currentProject: projects.current() };
    let profile: ProjectInput;
    try {
      profile = JSON.parse(await readFile(result.filePaths[0], 'utf8')) as ProjectInput;
    } catch (error) {
      throw new Error(`PROJECT_IMPORT_INVALID: 项目资料文件无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
    const project = await projects.import(profile);
    await sessions.selectProject(project.id);
    recordDataChange({ entity: 'project', action: 'imported', projectId: project.id, source: 'desktop' });
    return { canceled: false, project, currentProject: project };
  });
  ipcMain.handle('geo:open-platform', (_event, platform: Platform) => sessions.open(platform));
  ipcMain.handle('geo:workbuddy-status', () => workBuddyIntegrationStatus());
  ipcMain.handle('geo:workbuddy-connect', () => prepareWorkBuddyIntegration(true, cliPath));
  ipcMain.handle('geo:update-status', () => updateManager.getStatus());
  ipcMain.handle('geo:update-check', () => updateManager.check());
  ipcMain.handle('geo:update-install', () => {
    // electron-updater closes all BrowserWindows before app.before-quit on macOS.
    // Mark this before invoking it so our user-initiated close handler does not hide.
    closingForUpdate = true;
    const result = updateManager.install();
    if (!result.accepted) closingForUpdate = false;
    return result;
  });
  ipcMain.handle('geo:ui-overlay', (_event, open: boolean) => {
    sessions.setUiOverlayOpen(Boolean(open));
  });
  ipcMain.handle('geo:beta-activate', async (_event, code: string) => await updateManager.activateBeta(String(code || '')));
  ipcMain.handle('geo:beta-deactivate', () => updateManager.deactivateBeta());
  ipcMain.handle('geo:launch-at-login-status', () => ({ available: app.isPackaged, enabled: app.isPackaged && app.getLoginItemSettings().openAtLogin }));
  ipcMain.handle('geo:set-launch-at-login', (_event, enabled: boolean) => {
    if (!app.isPackaged) return { available: false, enabled: false };
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: Boolean(enabled), args: ['--background'] });
    return { available: true, enabled: app.getLoginItemSettings().openAtLogin };
  });
  ipcMain.handle('geo:copy-diagnostics', () => {
    const publisher = desktopStatus();
    const currentUpdate = updateManager.getStatus();
    const diagnostic = {
      generatedAt: new Date().toISOString(),
      app: { version: packageJson.version, platform: process.platform, arch: process.arch, packaged: app.isPackaged },
      cli: { installed: Boolean(cliPath), profile: 'production' as const },
      publisher: {
        ready: publisher.ready,
        busy: publisher.busy,
        executingPlatform: publisher.executingPlatform,
        projectSelected: Boolean(projects.current()),
        attentionCode: publisher.attentionRequired?.code ?? null,
      },
      update: {
        channel: currentUpdate.channel,
        phase: currentUpdate.phase,
        currentVersion: currentUpdate.currentVersion,
        availableVersion: currentUpdate.availableVersion,
      },
    };
    clipboard.writeText(JSON.stringify(diagnostic, null, 2));
    return { copied: true as const, diagnostic };
  });
  ipcMain.handle('geo:open-data-directory', async () => {
    const error = await shell.openPath(dataDirectory());
    return error ? { opened: false, error } : { opened: true };
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
