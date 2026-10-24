import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import { StartupLog } from './startup-log.js';
import { isWorkspaceFileUrl } from './workspace-file.js';

export function softwareRenderingRequested(dataDirectory: string): boolean {
  return process.platform === 'win32' && (process.argv.includes('--disable-gpu') || existsSync(join(dataDirectory, 'software-rendering')));
}

/** Uses native dialogs as well as HTML: a broken preload/GPU cannot hide the error. */
export class StartupSupport {
  private window: BrowserWindow | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ready = false;
  private prompting = false;
  private quitting = false;
  private failure: string | undefined;

  constructor(readonly log: StartupLog, private readonly dataDirectory: string) {
    app.on('before-quit', () => {
      this.quitting = true;
      clearTimeout(this.timer);
    });
    app.on('child-process-gone', (_event, details) => {
      log.record('child-process-gone', details);
      if (details.type === 'GPU' && !this.ready && !['clean-exit', 'killed'].includes(details.reason)) {
        void this.fail('GPU_PROCESS_GONE', `${details.reason} (${details.exitCode})`);
      }
    });
  }

  get isQuitting(): boolean { return this.quitting; }

  start(): void {
    this.ready = false;
    this.failure = undefined;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fail('STARTUP_TIMEOUT', '工作台在 30 秒内未完成启动'), 30_000);
    this.timer.unref();
  }

  attach(window: BrowserWindow, htmlPath: string): void {
    this.window = window;
    const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isWorkspaceFileUrl(event.senderFrame?.url, htmlPath);
    ipcMain.on('lingxi:startup-ready', (event) => {
      if (!trusted(event) || this.failure) {
        if (event.sender === window.webContents) this.log.record('startup.ready-rejected', {
          expectedUrl: pathToFileURL(htmlPath).href, receivedUrl: event.senderFrame?.url,
          mainFrame: event.senderFrame === window.webContents.mainFrame, failure: this.failure ?? null,
        });
        return;
      }
      this.ready = true;
      clearTimeout(this.timer);
      this.log.record('renderer.ready', { url: event.senderFrame?.url });
    });
    ipcMain.on('lingxi:startup-failed', (event, code: unknown, message: unknown) => {
      if (!trusted(event)) return;
      void this.fail(typeof code === 'string' ? code.slice(0, 80) : 'RENDERER_ERROR', typeof message === 'string' ? message.slice(0, 12_000) : '界面启动失败');
    });
    ipcMain.handle('lingxi:startup-copy', (event) => {
      if (!trusted(event)) throw new Error('不允许访问启动诊断');
      clipboard.writeText(this.log.report());
      return true;
    });
    window.webContents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.start();
    });
    window.webContents.on('did-finish-load', () => this.log.record('renderer.loaded'));
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) void this.fail('PAGE_LOAD_FAILED', `${code}: ${description}; ${url}`);
    });
    window.webContents.on('preload-error', (_event, path, error) => {
      void this.fail('PRELOAD_FAILED', `${path}\n${error.stack || error.message}`);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      if (!this.quitting) void this.fail('RENDERER_PROCESS_GONE', `${details.reason} (${details.exitCode})`);
    });
    window.webContents.on('unresponsive', () => {
      if (!this.ready) void this.fail('RENDERER_UNRESPONSIVE', '界面启动时停止响应');
    });
    window.webContents.on('console-message', (event) => {
      // Only our workspace, never embedded account pages or customer content.
      if (!this.ready && event.level === 'error') this.log.record('renderer.console-error', { message: event.message, line: event.lineNumber, source: event.sourceId });
    });
  }

  async fail(code: string, message: string): Promise<void> {
    this.log.record(code, { message });
    this.failure = code;
    clearTimeout(this.timer);
    if (this.prompting || this.quitting) return;
    this.prompting = true;
    try {
      const restartRequired = code === 'MAIN_STARTUP_FAILED' || !this.window;
      const buttons = ['复制诊断信息', restartRequired ? '重新启动应用' : '重新加载界面'];
      const compatibilityIndex = process.platform === 'win32' ? buttons.push('兼容模式重启') - 1 : -1;
      const closeIndex = buttons.push('关闭应用') - 1;
      let response: number;
      do {
        ({ response } = await dialog.showMessageBox({
          type: 'error', title: 'Lingxi Workspace 启动异常',
          message: '工作台未能正常显示',
          detail: `请点击“复制诊断信息”，将内容发给技术支持。\n错误编号：${this.failure}\n日志：${this.log.path ?? '内存记录'}${compatibilityIndex >= 0 ? '\n也可以尝试“兼容模式重启”，避开显卡加速兼容问题。' : ''}`,
          buttons, defaultId: 1, cancelId: closeIndex, noLink: true,
        }));
        if (response === 0) clipboard.writeText(this.log.report());
      } while (response === 0 && !this.quitting);
      if (this.quitting) return;
      if (response === compatibilityIndex) {
        // Persist the choice so future Store launches need no command line.
        writeFileSync(join(this.dataDirectory, 'software-rendering'), '1', { mode: 0o600 });
        this.log.record('restart.software-rendering');
        app.relaunch({ args: [...process.argv.slice(1).filter((arg) => arg !== '--background' && arg !== '--disable-gpu'), '--disable-gpu'] });
        app.exit(0);
      } else if (response === 1) {
        if (restartRequired || !this.window || this.window.isDestroyed()) {
          app.relaunch();
          app.exit(0);
        } else {
          this.start();
          this.window.webContents.reload();
          this.window.show();
        }
      } else app.exit(1);
    } catch (error) {
      this.log.record('failure-dialog-error', String(error));
      dialog.showErrorBox('Lingxi Workspace 启动异常', `${code}\n${message}\n日志：${this.log.path ?? '无法写入'}`);
    } finally {
      this.prompting = false;
    }
  }
}
