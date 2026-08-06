import { BrowserWindow, WebContents, WebContentsView } from 'electron';

export const BACKGROUND_VIEWPORT = { width: 1440, height: 1000 };

/**
 * A private render host for automation pages. It is a native window because a
 * detached WebContentsView has a 0x0 viewport and cannot receive Chromium
 * input events. The host is permanently hidden, absent from the task switcher,
 * and non-focusable, so it cannot take the customer's foreground application.
 */
export class BackgroundExecutionHost {
  private readonly host: BrowserWindow;
  private attachedView: WebContentsView | null = null;

  constructor() {
    this.host = new BrowserWindow({
      width: BACKGROUND_VIEWPORT.width,
      height: BACKGROUND_VIEWPORT.height,
      show: false,
      focusable: false,
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
    if (this.attachedView && this.attachedView !== view) this.host.contentView.removeChildView(this.attachedView);
    this.host.contentView.addChildView(view);
    view.webContents.setBackgroundThrottling(false);
    view.setVisible(true);
    view.setBounds({ x: 0, y: 0, ...BACKGROUND_VIEWPORT });
    this.attachedView = view;
  }

  detach(view: WebContentsView): void {
    if (this.attachedView !== view) return;
    this.host.contentView.removeChildView(view);
    view.setVisible(false);
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
      await debuggerApi.sendCommand('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
    } catch {
      // Direct DOM and Chromium input APIs remain usable if this lifecycle
      // command is unavailable in a future Electron version.
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  destroy(): void {
    if (!this.host.isDestroyed()) this.host.destroy();
    this.attachedView = null;
  }
}
