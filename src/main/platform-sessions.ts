import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, session, WebContentsView } from 'electron';
import type { DesktopStatus, Platform, PlatformStatus } from '../shared/protocol.js';
import { PLATFORMS } from '../shared/protocol.js';
import { fillBaijiaDraft } from './baijia-adapter.js';
import { fillPenguinDraft } from './penguin-adapter.js';
import { fillSohuDraft } from './sohu-adapter.js';
import { evidenceDirectory } from './runtime-paths.js';
import { setupStealthInjection, setupStealthSession, setupStealthUserAgent } from './stealth.js';
import { fillToutiaoDraft } from './toutiao-adapter.js';
import { fillZhihuDraft } from './zhihu-adapter.js';
import { fillNeteaseDraft } from './netease-adapter.js';
import { publishFilledDraft } from './publish-adapter.js';
import { restorePlatformCookies, snapshotPlatformCookies } from './cookie-vault.js';

const PLATFORM_URLS: Record<Platform, string> = {
  baijia: 'https://baijiahao.baidu.com/builder/rc/edit',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  zhihu: 'https://zhuanlan.zhihu.com/write',
  penguin: 'https://om.qq.com/main/creation/article',
  sohu: 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1',
  netease: 'https://mp.163.com/subscribe_v4/index.html#/article-publish',
};

interface ManagedView {
  platform: Platform;
  view: WebContentsView;
  partition: Electron.Session;
  loading: boolean;
  lastUsedAt: number;
}

const MAX_RESIDENT_PLATFORM_VIEWS = 1;

export function pickEvictionCandidate(
  views: Array<{ platform: Platform; lastUsedAt: number }>,
  activePlatform: Platform | null,
  requestedPlatform: Platform,
): Platform | null {
  return views
    .filter(({ platform }) => platform !== requestedPlatform)
    .sort((left, right) => {
      if (left.platform === activePlatform) return 1;
      if (right.platform === activePlatform) return -1;
      return left.lastUsedAt - right.lastUsedAt;
    })[0]?.platform ?? null;
}

export class PlatformSessions {
  private readonly views = new Map<Platform, ManagedView>();
  private activePlatform: Platform | null = null;

  constructor(private readonly window: BrowserWindow, private readonly version: string) {}

  async open(platform: Platform): Promise<PlatformStatus> {
    let managed = this.views.get(platform);
    if (!managed) {
      this.evictIdleView(platform);
      const useMinimalBrowserEnvironment = platform === 'toutiao' || platform === 'netease';
      const view = new WebContentsView({
        webPreferences: {
          partition: `persist:geo-publisher-${platform}`,
          contextIsolation: false, // 必须设为 false，让 preload 可以直接修改页面环境
          sandbox: false, // 必须设为 false，让 preload 有足够权限
          nodeIntegration: false, // 仍然禁用 Node.js
          backgroundThrottling: true,
          // 反检测配置
          webSecurity: true,
          allowRunningInsecureContent: false,
          enableWebSQL: false,
          // 使用专门的反检测 preload 脚本
          preload: useMinimalBrowserEnvironment ? undefined : join(__dirname, '..', 'stealth-preload.cjs'),
        },
      });

      // 为该平台的session配置反检测
      const platformSession = session.fromPartition(`persist:geo-publisher-${platform}`);
      // 头条与网易的编辑器会被 JS 指纹改写干扰，只保留 UA 中移除 Electron 标识。
      if (!useMinimalBrowserEnvironment) setupStealthSession(platformSession);
      else setupStealthUserAgent(platformSession);
      await restorePlatformCookies(platformSession, platform);

      managed = { platform, view, partition: platformSession, loading: false, lastUsedAt: Date.now() };
      this.views.set(platform, managed);
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (managed && !managed.loading && url !== managed.view.webContents.getURL()) {
          void this.loadUrl(managed, url);
        }
        return { action: 'deny' };
      });
      view.webContents.on('did-start-loading', () => { if (managed) managed.loading = true; });
      view.webContents.on('console-message', (_event, level, message) => {
        if (level >= 2) console.error(`[${platform}] renderer: ${message}`);
      });
      view.webContents.on('render-process-gone', (_event, details) => {
        console.error(`[${platform}] renderer process gone: ${details.reason}`);
        if (managed && this.activePlatform === platform && !managed.view.webContents.isDestroyed()) {
          setTimeout(() => {
            if (!managed || managed.view.webContents.isDestroyed()) return;
            void this.loadUrl(managed, managed.view.webContents.getURL() || PLATFORM_URLS[platform]);
          }, 800);
        }
      });
      view.webContents.on('dom-ready', () => this.restoreActiveView(platform));
      view.webContents.on('did-stop-loading', () => {
        if (managed) {
          managed.loading = false;
          this.restoreActiveView(platform);
          void managed.partition.flushStorageData();
          void snapshotPlatformCookies(managed.partition, managed.platform).catch(() => undefined);
        }
      });
      platformSession.cookies.on('changed', () => {
        void platformSession.flushStorageData();
        void snapshotPlatformCookies(platformSession, platform).catch(() => undefined);
      });

      // 设置反检测脚本注入（多时机注入确保生效）
      if (!useMinimalBrowserEnvironment) setupStealthInjection(view.webContents);

      this.attach(platform);
      this.window.show();
      await this.loadUrl(managed, PLATFORM_URLS[platform]);
    }
    if (this.activePlatform !== platform) this.attach(platform);
    if (!this.window.isVisible()) this.window.show();
    return this.platformStatus(platform);
  }

  attach(platform: Platform): void {
    const managed = this.views.get(platform);
    if (!managed) throw new Error(`平台尚未创建：${platform}`);
    if (this.activePlatform) {
      const active = this.views.get(this.activePlatform);
      if (active) {
        active.lastUsedAt = Date.now();
        active.view.webContents.setBackgroundThrottling(true);
        this.window.contentView.removeChildView(active.view);
      }
    }
    this.window.contentView.addChildView(managed.view);
    managed.lastUsedAt = Date.now();
    managed.view.webContents.setBackgroundThrottling(false);
    managed.view.setVisible(true);
    managed.view.setBounds(this.viewBounds());
    this.activePlatform = platform;
  }

  resize(): void {
    if (!this.activePlatform) return;
    this.views.get(this.activePlatform)?.view.setBounds(this.viewBounds());
  }

  async fillDraft(platform: 'baijia' | 'toutiao' | 'zhihu' | 'penguin' | 'sohu' | 'netease', title: string, html: string, coverPath: string, tags: string[]): Promise<unknown> {
    await this.open(platform);
    const managed = this.views.get(platform);
    if (!managed) throw new Error(`${platform} 浏览器创建失败`);
    const result = platform === 'baijia'
      ? await fillBaijiaDraft(managed.view.webContents, title, html, coverPath)
      : platform === 'toutiao'
        ? await fillToutiaoDraft(managed.view.webContents, title, html, coverPath)
        : platform === 'zhihu'
          ? await fillZhihuDraft(managed.view.webContents, title, html)
          : platform === 'penguin'
            ? await fillPenguinDraft(managed.view.webContents, title, html, tags)
            : platform === 'sohu'
              ? await fillSohuDraft(managed.view.webContents, title, html)
              : await fillNeteaseDraft(managed.view.webContents, title, html, coverPath);
    if (platform === 'sohu') {
      const settingsScreenshotPath = await this.captureEvidence(platform, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => { const editor = document.querySelector('.ql-editor[contenteditable="true"]'); if (!(editor instanceof HTMLElement)) return false; editor.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const screenshotPath = await this.captureEvidence(platform, 'fill-content');
      return { ...result, screenshotPath, settingsScreenshotPath };
    }
    if (platform === 'toutiao') {
      const settingsScreenshotPath = await this.captureEvidence(platform, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
        const single = [...document.querySelectorAll('label,[role="radio"],.byte-radio,.semi-radio')].filter(visible).find((element) => normalize(element.textContent) === '单图');
        let root = single instanceof HTMLElement ? single.parentElement : null;
        for (let depth = 0; root && depth < 12; depth += 1) { const text = normalize(root.textContent); if (text.includes('展示封面') && text.includes('无封面')) break; root = root.parentElement; }
        if (!(root instanceof HTMLElement)) return false; root.scrollIntoView({ block: 'center', inline: 'nearest' }); return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const screenshotPath = await this.captureEvidence(platform, 'fill-cover');
      return { ...result, screenshotPath, settingsScreenshotPath };
    }
    const screenshotPath = await this.captureEvidence(platform, 'fill');
    return { ...result, screenshotPath };
  }

  async publishDraft(platform: Platform, title: string, html: string, coverPath: string, tags: string[]): Promise<unknown> {
    const fill = await this.fillDraft(platform, title, html, coverPath, tags);
    const managed = this.views.get(platform);
    if (!managed) throw new Error(`PUBLISH_VIEW_MISSING: ${platform} 发布页面不存在`);
    const result = await publishFilledDraft(managed.view.webContents, platform, title);
    const screenshotPath = await this.captureEvidence(platform, `publish-${result.status}`);
    return { fill, ...result, screenshotPath };
  }

  async inspect(platform: Platform): Promise<PlatformStatus & { textStart: string; controls: unknown[]; editables: unknown[]; buttons: unknown[]; dialogs: unknown[]; storage: unknown[] }> {
    const managed = this.views.get(platform);
    if (!managed) return { ...this.platformStatus(platform), textStart: '', controls: [], editables: [], buttons: [], dialogs: [], storage: [] };
    const details = await managed.view.webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })();
      const controls = [...document.querySelectorAll('label,[role="checkbox"],[role="radio"]')]
        .filter(visible)
        .filter((element) => element.matches('[role="checkbox"],[role="radio"]')
          || element.querySelector('input[type="checkbox"],input[type="radio"]'))
        .slice(0, 80)
        .map((element) => {
          const input = element.matches('input') ? element : element.querySelector('input[type="checkbox"],input[type="radio"]');
          return {
            type: input?.getAttribute('type') || element.getAttribute('role'),
            value: input?.getAttribute('value'),
            checked: input instanceof HTMLInputElement ? input.checked : element.getAttribute('aria-checked') === 'true',
            text: normalize(element.textContent).slice(0, 80),
            className: String(element.className || '').slice(0, 160),
            inputClassName: String(input?.className || '').slice(0, 160),
            inputId: input?.getAttribute('id'),
          };
        });
      return {
        textStart: normalize(document.body?.innerText).slice(0, 800),
        controls,
        editables: [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"],iframe')]
          .filter((element) => element instanceof HTMLIFrameElement || visible(element))
          .slice(0, 80)
          .map((element) => {
            const rect = element instanceof HTMLElement ? element.getBoundingClientRect() : { width: 0, height: 0 };
            return {
              tag: element.tagName,
              type: element.getAttribute('type'),
              placeholder: element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || element.getAttribute('aria-label'),
              className: String(element.className || '').slice(0, 180),
              contenteditable: element.getAttribute('contenteditable'),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              text: normalize(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                ? element.value : element.textContent).slice(0, 100),
              outerHTML: element.outerHTML.slice(0, 1000),
              parentOuterHTML: element.parentElement?.parentElement?.parentElement?.outerHTML?.slice(0, 3000) || '',
            };
          }),
        buttons: [...document.querySelectorAll('button,[role="button"]')]
          .filter(visible)
          .slice(0, 100)
          .map((element) => ({
            text: normalize(element.textContent).slice(0, 80),
            className: String(element.className || '').slice(0, 180),
            ariaLabel: element.getAttribute('aria-label'),
            title: element.getAttribute('title'),
            dataAttrs: [...element.attributes].filter((attribute) => attribute.name.startsWith('data-')).slice(0, 8).map((attribute) => [attribute.name, attribute.value]),
            outerHTML: element.outerHTML.slice(0, 1200),
            disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
          })),
        dialogs: [...document.querySelectorAll('[role="dialog"],[class*="message"],[class*="Message"],[class*="modal"],[class*="Modal"]')]
          .filter(visible).slice(0, 20).map((element) => ({ text: normalize(element.textContent).slice(0, 300), className: String(element.className || '').slice(0, 200), outerHTML: element.outerHTML.slice(0, 2000) })),
        storage: Object.keys(localStorage).slice(0, 100).map((key) => ({ key, length: String(localStorage.getItem(key) || '').length, valueStart: String(localStorage.getItem(key) || '').slice(0, 300) })),
      };
    })()`);
    return { ...this.platformStatus(platform), ...details };
  }

  status(): DesktopStatus {
    return {
      version: this.version,
      pid: process.pid,
      ready: true,
      activePlatform: this.activePlatform,
      platforms: PLATFORMS.map((platform) => this.platformStatus(platform)),
    };
  }

  async flushStorage(): Promise<void> {
    await Promise.all([...this.views.values()].flatMap(({ platform, partition }) => [
      partition.flushStorageData(),
      snapshotPlatformCookies(partition, platform),
    ]));
  }

  private platformStatus(platform: Platform): PlatformStatus {
    const managed = this.views.get(platform);
    return {
      platform,
      created: Boolean(managed),
      attached: this.activePlatform === platform,
      loading: managed?.loading ?? false,
      url: managed?.view.webContents.getURL() ?? '',
      title: managed?.view.webContents.getTitle() ?? '',
    };
  }

  private evictIdleView(requestedPlatform: Platform): void {
    if (this.views.size < MAX_RESIDENT_PLATFORM_VIEWS) return;
    const candidate = pickEvictionCandidate(
      [...this.views.values()].map(({ platform, lastUsedAt }) => ({ platform, lastUsedAt })),
      this.activePlatform,
      requestedPlatform,
    );
    if (!candidate) return;
    const managed = this.views.get(candidate);
    if (!managed) return;
    if (this.activePlatform === candidate) {
      this.window.contentView.removeChildView(managed.view);
      this.activePlatform = null;
    }
    managed.view.webContents.close({ waitForBeforeUnload: false });
    this.views.delete(candidate);
  }

  private async loadUrl(managed: ManagedView, url: string): Promise<void> {
    if (managed.loading) return;
    managed.loading = true;
    try {
      await managed.view.webContents.loadURL(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ERR_ABORTED \(-3\)/.test(message)) throw error;
    } finally {
      managed.loading = managed.view.webContents.isLoading();
      this.restoreActiveView(managed.platform);
    }
  }

  private restoreActiveView(platform: Platform): void {
    if (this.activePlatform !== platform) return;
    const managed = this.views.get(platform);
    if (!managed || managed.view.webContents.isDestroyed()) return;
    managed.view.setVisible(true);
    managed.view.setBounds(this.viewBounds());
  }

  private viewBounds(): { x: number; y: number; width: number; height: number } {
    const [width = 920, height = 640] = this.window.getContentSize();
    return { x: 220, y: 56, width: Math.max(320, width - 220), height: Math.max(240, height - 56) };
  }

  private async captureEvidence(platform: Platform, stage: string): Promise<string> {
    const managed = this.views.get(platform);
    if (!managed) throw new Error(`平台尚未创建：${platform}`);
    const directory = join(evidenceDirectory(), new Date().toISOString().slice(0, 10));
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-${platform}-${stage}.png`);
    const image = await managed.view.webContents.capturePage();
    await writeFile(path, image.toPNG());
    return path;
  }
}
