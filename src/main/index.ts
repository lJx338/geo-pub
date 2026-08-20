import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import packageJson from '../../package.json' with { type: 'json' };
import { desktopDistributionRequestSchema, type ControlRequest, type DataChangeEvent, type Platform } from '../shared/protocol.js';
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
import { prepareWorkBuddyIntegration, prepareWorkBuddyMaterialOrganization, workBuddyIntegrationStatus } from './workbuddy-integration.js';
import { DistributionService } from './distribution-service.js';
import { runIdleMaintenance } from './maintenance.js';

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
  let distributionRunning = false;
  const sessions = new PlatformSessions(window, packageJson.version, (attention) => {
    if (!window.isDestroyed()) window.webContents.send('geo:attention-required', attention);
  }, () => {
    if (!window.isDestroyed()) window.webContents.send('geo:status-changed', { ...sessions.status(), busy: sessions.isBusy() || distributionRunning, cliPath, currentProject: projects.current() });
  });
  if (projects.current()) await sessions.selectProject(projects.current()!.id);
  const updateManager = new UpdateManager(packageJson.version, () => sessions.isBusy() || distributionRunning, (status) => {
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

  const desktopStatus = () => ({ ...sessions.status(), busy: sessions.isBusy() || distributionRunning, cliPath, currentProject: projects.current() });
  const ensureAppIdle = (message = '发布任务运行中，暂时不能执行此操作') => {
    if (sessions.isBusy() || distributionRunning) throw new Error(`PUBLISHER_BUSY: ${message}`);
  };
  const recordDataChange = (change: Omit<DataChangeEvent, 'revision' | 'changedAt'>) => {
    const event = dataChanges.record(change);
    if (!window.isDestroyed()) window.webContents.send('geo:data-changed', event);
    return event;
  };
  const workspaceSnapshot = async () => {
    let snapshot = { revision: dataChanges.current(), projects: projects.list(), currentProject: projects.current(), items: [] as Awaited<ReturnType<ContentStore['list']>>, contentCounts: {} as Record<string, number> };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = dataChanges.current();
      const currentProject = projects.current();
      const project = currentProject;
      const kinds: ContentKind[] = ['article', 'topic', 'material', 'distribution'];
      const pages = project ? await Promise.all(kinds.map((kind) => content.listPage(project.id, kind, {}, { limit: kind === 'distribution' ? 12 : 50 }))) : [];
      snapshot = {
        revision,
        projects: projects.list(),
        currentProject,
        items: pages.flatMap((page) => page.items),
        contentCounts: Object.fromEntries(kinds.map((kind, index) => [kind, pages[index]?.total ?? 0])),
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
  const distribution = new DistributionService(content, sessions, (record, source) => {
    recordDataChange({ entity: 'content', action: 'saved', projectId: record.projectId, itemId: record.id, contentKind: record.kind, source });
  });
  const route = async (request: ControlRequest): Promise<unknown> => {
    if (request.action === 'status') return desktopStatus();
    if (request.action === 'project.list') return { projects: projects.list(), currentProject: projects.current() };
    if (request.action === 'project.current') return { project: projects.current() };
    if (request.action === 'project.get') return { project: projects.get(request.projectId) };
    if (request.action === 'project.create') {
      ensureAppIdle('发布任务运行中，暂时不能新建客户项目');
      const project = await projects.create(request.project as ProjectInput);
      await sessions.selectProject(project.id);
      recordDataChange({ entity: 'project', action: 'created', projectId: project.id, source: 'cli' });
      return { project, currentProject: project };
    }
    if (request.action === 'project.update') {
      ensureAppIdle('发布任务运行中，暂时不能修改客户项目');
      const project = await projects.update(request.projectId, request.project as Partial<ProjectInput>);
      recordDataChange({ entity: 'project', action: 'updated', projectId: project.id, source: 'cli' });
      return { project };
    }
    if (request.action === 'project.select') {
      ensureAppIdle('发布任务运行中，暂时不能切换客户项目');
      const project = await projects.select(request.projectId);
      await sessions.selectProject(project.id);
      recordDataChange({ entity: 'project', action: 'selected', projectId: project.id, source: 'cli' });
      return { project, currentProject: project };
    }
    if (request.action === 'project.archive') {
      ensureAppIdle('发布任务运行中，暂时不能归档客户项目');
      await projects.archive(request.projectId);
      const current = projects.current();
      if (current) await sessions.selectProject(current.id);
      else await sessions.clearProject();
      recordDataChange({ entity: 'project', action: 'archived', projectId: request.projectId, source: 'cli' });
      return { currentProject: current };
    }
    if (request.action === 'content.list') {
      ensureCurrentContentProject(request.projectId);
      const filter = (request.filter || {}) as ContentFilter;
      if (filter.limit || filter.beforeUpdatedAt || filter.beforeId) {
        const { limit, beforeUpdatedAt, beforeId, ...baseFilter } = filter;
        return await content.listPage(request.projectId, request.kind as ContentKind | undefined, baseFilter, { limit, beforeUpdatedAt, beforeId });
      }
      return { items: await content.list(request.projectId, request.kind as ContentKind | undefined, filter) };
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
    if (request.action === 'material.pending') {
      ensureCurrentContentProject(request.projectId);
      return { items: await content.pendingImageMaterials(request.projectId, request.limit) };
    }
    if (request.action === 'material.get') {
      ensureCurrentContentProject(request.projectId);
      return { item: await content.imageMaterial(request.projectId, request.materialId) };
    }
    if (request.action === 'material.analyze') {
      ensureCurrentContentProject(request.projectId);
      const item = await content.analyzeImageMaterial(request.projectId, request.materialId, request.analysis);
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
    if (request.action === 'platform.open') {
      if (distributionRunning) throw new Error('PUBLISHER_BUSY: 分发任务运行中，暂时不能切换平台');
      return await sessions.open(request.platform);
    }
    if (request.action === 'platform.inspect') return await sessions.inspect(request.platform);
    if (request.action === 'draft.fill') {
      if (distributionRunning) throw new Error('PUBLISHER_BUSY: 桌面端分发任务运行中，请等待完成');
      return await distribution.runDirect({ projectId: request.projectId, platform: request.platform, document: request.document, coverPath: request.coverPath, mode: 'fill' });
    }
    if (request.action === 'draft.publish') {
      if (distributionRunning) throw new Error('PUBLISHER_BUSY: 桌面端分发任务运行中，请等待完成');
      return await distribution.runDirect({ projectId: request.projectId, platform: request.platform, document: request.document, coverPath: request.coverPath, mode: 'publish' });
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
  ipcMain.handle('geo:content-list', async (_event, projectId: string, kind?: ContentKind, filter: ContentFilter = {}) => {
    if (filter.limit || filter.beforeUpdatedAt || filter.beforeId) {
      const { limit, beforeUpdatedAt, beforeId, ...baseFilter } = filter;
      return await content.listPage(projectId, kind, baseFilter, { limit, beforeUpdatedAt, beforeId });
    }
    return { items: await content.list(projectId, kind, filter) };
  });
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
    const selection = await dialog.showOpenDialog(window, { title: '添加图片素材', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片素材', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (selection.canceled) return { canceled: true, items: [] };
    const imported = [];
    for (const sourcePath of selection.filePaths) {
      const item = await content.importMaterial(projectId, sourcePath);
      imported.push(item); recordDataChange({ entity: 'content', action: 'saved', projectId, itemId: item.id, contentKind: item.kind, source: 'desktop' });
    }
    return { canceled: false, items: imported };
  });
  ipcMain.handle('geo:material-thumbnail', async (_event, projectId: string, materialId: string) => {
    ensureCurrentContentProject(projectId);
    const item = await content.imageMaterial(projectId, materialId);
    const sourcePath = String(item.payload.sourcePath);
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) {
      const bytes = await readFile(sourcePath);
      const extension = String(item.payload.extension || 'png').toLowerCase();
      const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : 'image/png';
      return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, width: 0, height: 0 };
    }
    const size = image.getSize();
    const thumbnail = size.width > 360 ? image.resize({ width: 360, quality: 'good' }) : image;
    return { dataUrl: thumbnail.toDataURL(), width: size.width, height: size.height };
  });
  ipcMain.handle('geo:topic-variant', async (_event, projectId: string, topicId: string, input: ContentInput) => {
    if (!projects.get(projectId)) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    const item = await content.createTopicVariant(projectId, topicId, input);
    recordDataChange({ entity: 'content', action: 'saved', projectId, itemId: item.id, contentKind: item.kind, source: 'desktop' });
    return { item };
  });
  ipcMain.handle('geo:project-create', async (_event, input: ProjectInput) => {
    ensureAppIdle('发布任务运行中，暂时不能新建客户项目');
    const project = await projects.create(input);
    await sessions.selectProject(project.id);
    recordDataChange({ entity: 'project', action: 'created', projectId: project.id, source: 'desktop' });
    return { project, currentProject: project };
  });
  ipcMain.handle('geo:project-update', async (_event, id: string, input: Partial<ProjectInput>) => {
    ensureAppIdle('发布任务运行中，暂时不能修改客户项目');
    const project = await projects.update(id, input);
    recordDataChange({ entity: 'project', action: 'updated', projectId: project.id, source: 'desktop' });
    return { project };
  });
  ipcMain.handle('geo:project-select', async (_event, id: string) => {
    ensureAppIdle('发布任务运行中，暂时不能切换客户项目');
    const project = await projects.select(id);
    await sessions.selectProject(project.id);
    recordDataChange({ entity: 'project', action: 'selected', projectId: project.id, source: 'desktop' });
    return { project, currentProject: project };
  });
  ipcMain.handle('geo:project-archive', async (_event, id: string) => {
    ensureAppIdle('发布任务运行中，暂时不能归档客户项目');
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
    ensureAppIdle('发布任务运行中，暂时不能导入客户项目');
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
  ipcMain.handle('geo:open-platform', async (_event, platform: Platform) => {
    const result = await sessions.open(platform);
    if (!window.isDestroyed()) window.webContents.send('geo:status-changed', desktopStatus());
    return result;
  });
  ipcMain.handle('geo:hide-platform', () => {
    sessions.hideActivePlatform();
    const status = desktopStatus();
    if (!window.isDestroyed()) window.webContents.send('geo:status-changed', status);
    return status;
  });
  ipcMain.handle('geo:distribution-cover-choose', async () => {
    ensureAppIdle('平台任务运行中，暂时不能选择封面');
    const result = await dialog.showOpenDialog(window, {
      title: '选择文章封面', properties: ['openFile'],
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    return { canceled: result.canceled, filePath: result.filePaths[0] || '' };
  });
  ipcMain.handle('geo:distribution-run', async (_event, rawInput: unknown) => {
    ensureAppIdle('已有任务正在执行，请等待完成');
    const input = desktopDistributionRequestSchema.parse(rawInput);
    ensureCurrentContentProject(input.projectId);
    distributionRunning = true;
    if (!window.isDestroyed()) window.webContents.send('geo:status-changed', desktopStatus());
    try {
      return await distribution.run(input);
    } finally {
      distributionRunning = false;
      if (!window.isDestroyed()) window.webContents.send('geo:status-changed', desktopStatus());
    }
  });
  ipcMain.handle('geo:workbuddy-status', () => workBuddyIntegrationStatus());
  ipcMain.handle('geo:workbuddy-connect', () => prepareWorkBuddyIntegration(true, cliPath));
  ipcMain.handle('geo:workbuddy-organize-materials', () => prepareWorkBuddyMaterialOrganization(cliPath));
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
  ipcMain.handle('geo:copy-text', (_event, value: string) => {
    const text = String(value || '').slice(0, 20_000);
    clipboard.writeText(text);
    return { copied: true as const };
  });
  ipcMain.handle('geo:open-data-directory', async () => {
    const error = await shell.openPath(dataDirectory());
    return error ? { opened: false, error } : { opened: true };
  });
  await window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  if (!startsInBackground) showWindow();
  updateManager.start();
  // Evidence and updater downloads are diagnostic/temporary data. Clean them
  // after startup, but never while a platform or distribution task is active.
  const runMaintenanceIfIdle = () => {
    if (!sessions.isBusy() && !distributionRunning) void runIdleMaintenance().catch(() => undefined);
  };
  setTimeout(runMaintenanceIfIdle, 15_000).unref();
  const maintenanceTimer = setInterval(runMaintenanceIfIdle, 24 * 60 * 60 * 1000);
  maintenanceTimer.unref();
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    clearInterval(maintenanceTimer);
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
