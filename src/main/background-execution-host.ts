import { BrowserWindow, WebContents, WebContentsView } from 'electron';

export const BACKGROUND_VIEWPORT = { width: 1440, height: 1000 };

export class BackgroundExecutionHost {
  private readonly window: BrowserWindow;
  private attachedView: WebContentsView | null = null;

  constructor() {
    this.window = new BrowserWindow({
      width: BACKGROUND_VIEWPORT.width,
      height: BACKGROUND_VIEWPORT.height,
      show: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
  }

  attach(view: WebContentsView): void {
    if (this.attachedView && this.attachedView !== view) this.window.contentView.removeChildView(this.attachedView);
    this.window.contentView.addChildView(view);
    view.webContents.setBackgroundThrottling(false);
    view.setVisible(true);
    view.setBounds({ x: 0, y: 0, ...BACKGROUND_VIEWPORT });
    this.attachedView = view;
  }

  detach(view: WebContentsView): void {
    if (this.attachedView !== view) return;
    this.window.contentView.removeChildView(view);
    this.attachedView = null;
  }

  restore(view: WebContentsView): void {
    if (this.attachedView !== view) return;
    view.webContents.setBackgroundThrottling(false);
    view.setVisible(true);
    view.setBounds({ x: 0, y: 0, ...BACKGROUND_VIEWPORT });
  }

  async prepare(webContents: WebContents): Promise<void> {
    webContents.setBackgroundThrottling(false);
    const debuggerApi = webContents.debugger;
    const attachedHere = !debuggerApi.isAttached();
    try {
      if (attachedHere) debuggerApi.attach('1.3');
      await debuggerApi.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await debuggerApi.sendCommand('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
    } catch {
      // The page remains usable through direct WebContents input even if a Chromium command is unavailable.
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  destroy(): void {
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
