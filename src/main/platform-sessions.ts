import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, session, WebContents, WebContentsView } from 'electron';
import type { DesktopStatus, Platform, PlatformStatus } from '../shared/protocol.js';
import { PLATFORMS } from '../shared/protocol.js';
import { BackgroundExecutionHost } from './background-execution-host.js';
import { AttentionRequiredError, type AttentionCode, type AttentionRequired } from './attention-required.js';
import { fillBaijiaDraft } from './baijia-adapter.js';
import { fillNeteaseDraft } from './netease-adapter.js';
import { fillPenguinDraft } from './penguin-adapter.js';
import { publishFilledDraft, type PublishResult } from './publish-adapter.js';
import { fillSohuDraft } from './sohu-adapter.js';
import { evidenceDirectory } from './runtime-paths.js';
import { setupStealthInjection, setupStealthSession, setupStealthUserAgent } from './stealth.js';
import { fillToutiaoDraft } from './toutiao-adapter.js';
import { fillZhihuDraft } from './zhihu-adapter.js';
import { restorePlatformCookies, snapshotPlatformCookies } from './cookie-vault.js';

const defaultPlatformUrls: Record<Platform, string> = {
  baijia: 'https://baijiahao.baidu.com/builder/rc/edit',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  zhihu: 'https://zhuanlan.zhihu.com/write',
  penguin: 'https://om.qq.com/main/creation/article',
  sohu: 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1',
  netease: 'https://mp.163.com/subscribe_v4/index.html#/article-publish',
};

const PLATFORM_URLS: Record<Platform, string> = process.env.GEO_PUBLISHER_TEST_PLATFORM_URL
  ? Object.fromEntries(PLATFORMS.map((platform) => [platform, process.env.GEO_PUBLISHER_TEST_PLATFORM_URL])) as Record<Platform, string>
  : defaultPlatformUrls;

type ViewHost = 'interactive' | 'background';

interface ManagedView {
  platform: Platform;
  view: WebContentsView;
  partition: Electron.Session;
  host: ViewHost;
  loading: boolean;
  lastUsedAt: number;
}

const MAX_RESIDENT_INTERACTIVE_VIEWS = 1;

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

export function platformRuntimeState(
  created: boolean,
  attached: boolean,
  executingInBackground = false,
): PlatformStatus['runtimeState'] {
  if (attached) return 'active';
  if (executingInBackground) return 'background';
  return created ? 'resident' : 'not_loaded';
}

function originalErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? null;
}

function attentionFromError(platform: Platform, error: unknown, url: string): AttentionRequired | null {
  const message = error instanceof Error ? error.message : String(error);
  const original = originalErrorCode(error);
  if (original?.endsWith('_LOGIN_REQUIRED')) {
    return { platform, code: 'LOGIN_REQUIRED', message: `${original}: 请完成登录后重新执行任务`, url };
  }
  if (original?.endsWith('_VERIFICATION_REQUIRED') || /(?:验证码|滑块验证|人机验证|安全验证)/.test(message)) {
    return { platform, code: 'VERIFICATION_REQUIRED', message: `${original || 'VERIFICATION_REQUIRED'}: 请完成验证后重新执行任务`, url };
  }
  if (/(?:风控|账号异常|异常操作|风险控制)/.test(message)) {
    return { platform, code: 'RISK_CONTROL_REQUIRED', message: `${original || 'RISK_CONTROL_REQUIRED'}: 请处理平台风险提示后重新执行任务`, url };
  }
  return null;
}

async function detectVisibleAttention(webContents: WebContents, platform: Platform): Promise<AttentionRequired | null> {
  const state = await webContents.executeJavaScript(`(() => {
    const visible=(element)=>element instanceof HTMLElement&&(()=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';})();
    const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim();
    const dialogs=[...document.querySelectorAll('[role="dialog"],[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"],[class*="verify"],[class*="Verify"]')]
      .filter(visible).map((element)=>normalize(element.textContent)).join(' ');
    const hasPassword=[...document.querySelectorAll('input[type="password"]')].some(visible);
    const visibleText=[...document.querySelectorAll('button,a,[role="button"],label')].filter(visible).map((element)=>normalize(element.textContent)).join(' ');
    return { url: location.href, dialogs, hasPassword, visibleText };
  })()`);
  const text = `${state.dialogs} ${state.visibleText}`;
  if (/(?:验证码|滑块验证|人机验证|安全验证|请完成验证)/.test(text)) {
    return { platform, code: 'VERIFICATION_REQUIRED', message: 'VERIFICATION_REQUIRED: 页面出现可见验证，请完成后重新执行任务', url: state.url };
  }
  if (/(?:风控|账号异常|异常操作|风险控制|安全校验)/.test(text)) {
    return { platform, code: 'RISK_CONTROL_REQUIRED', message: 'RISK_CONTROL_REQUIRED: 页面出现可见风险提示，请处理后重新执行任务', url: state.url };
  }
  if (state.hasPassword || /(?:登录|扫码登录|请先登录|重新登录)/.test(text) || /(?:login|passport)/i.test(state.url)) {
    return { platform, code: 'LOGIN_REQUIRED', message: 'LOGIN_REQUIRED: 页面需要登录，请完成后重新执行任务', url: state.url };
  }
  return null;
}

export class PlatformSessions {
  private readonly views = new Map<Platform, ManagedView>();
  private readonly executionHost = new BackgroundExecutionHost();
  private background: ManagedView | null = null;
  private activePlatform: Platform | null = null;
  private executingPlatform: Platform | null = null;
  private attentionRequired: AttentionRequired | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;

  constructor(
    private readonly window: BrowserWindow,
    private readonly version: string,
    private readonly onAttentionRequired: (attention: AttentionRequired) => void = () => undefined,
  ) {}

  async open(platform: Platform): Promise<PlatformStatus> {
    if (this.isBusy()) throw new Error('PUBLISHER_BUSY: 发布任务运行中，请等待任务完成后再打开平台页面');
    if (this.background?.platform === platform) {
      await this.promoteBackground(platform);
      return this.platformStatus(platform);
    }
    let managed = this.views.get(platform);
    if (!managed) {
      this.evictIdleInteractiveView(platform);
      managed = await this.createView(platform, 'interactive');
      this.views.set(platform, managed);
      this.attachInteractive(managed);
      await this.loadUrl(managed, PLATFORM_URLS[platform]);
    } else if (this.activePlatform !== platform) {
      this.attachInteractive(managed);
    }
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    this.attentionRequired = null;
    return this.platformStatus(platform);
  }

  resize(): void {
    if (!this.activePlatform) return;
    const managed = this.views.get(this.activePlatform);
    if (managed) this.restoreManagedView(managed);
  }

  async fillDraft(platform: Platform, title: string, html: string, coverPath: string, tags: string[]): Promise<unknown> {
    return await this.runExclusive(() => this.fillDraftInternal(platform, title, html, coverPath, tags));
  }

  private async fillDraftInternal(platform: Platform, title: string, html: string, coverPath: string, tags: string[]): Promise<unknown> {
    const managed = await this.openBackground(platform);
    try {
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
      return await this.captureFillEvidence(managed, result);
    } catch (error) {
      const attention = await this.promoteForAttention(managed, error);
      if (attention) throw new AttentionRequiredError(attention, originalErrorCode(error));
      throw error;
    }
  }

  async publishDraft(platform: Platform, title: string, html: string, coverPath: string, tags: string[]): Promise<unknown> {
    return await this.runExclusive(async () => {
      const fill = await this.fillDraftInternal(platform, title, html, coverPath, tags);
      const managed = this.background;
      if (!managed || managed.platform !== platform) throw new Error(`PUBLISH_VIEW_MISSING: ${platform} 发布页面不存在`);
      try {
        const result = await publishFilledDraft(managed.view.webContents, platform, title);
        const screenshotPath = await this.captureEvidence(managed, `publish-${result.status}`);
        if (result.status === 'action_required') await this.promoteForVisibleAttention(managed, result);
        if (result.status === 'success') await this.closeBackground();
        return { fill, ...result, screenshotPath };
      } catch (error) {
        const attention = await this.promoteForAttention(managed, error);
        if (attention) throw new AttentionRequiredError(attention, originalErrorCode(error));
        throw error;
      }
    });
  }

  async inspect(platform: Platform): Promise<PlatformStatus & { textStart: string; controls: unknown[]; editables: unknown[]; buttons: unknown[]; dialogs: unknown[]; storage: unknown[]; attentionRequired: AttentionRequired | null }> {
    return await this.runExclusive(() => this.inspectInternal(platform));
  }

  private async inspectInternal(platform: Platform): Promise<PlatformStatus & { textStart: string; controls: unknown[]; editables: unknown[]; buttons: unknown[]; dialogs: unknown[]; storage: unknown[]; attentionRequired: AttentionRequired | null }> {
    const managed = await this.openBackground(platform);
    const details = await managed.view.webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })();
      const controls = [...document.querySelectorAll('label,[role="checkbox"],[role="radio"]')].filter(visible).filter((element) => element.matches('[role="checkbox"],[role="radio"]') || element.querySelector('input[type="checkbox"],input[type="radio"]')).slice(0, 80).map((element) => {
        const input = element.matches('input') ? element : element.querySelector('input[type="checkbox"],input[type="radio"]');
        return { type: input?.getAttribute('type') || element.getAttribute('role'), value: input?.getAttribute('value'), checked: input instanceof HTMLInputElement ? input.checked : element.getAttribute('aria-checked') === 'true', text: normalize(element.textContent).slice(0, 80), className: String(element.className || '').slice(0, 160), inputClassName: String(input?.className || '').slice(0, 160), inputId: input?.getAttribute('id') };
      });
      return {
        textStart: normalize(document.body?.innerText).slice(0, 800), controls,
        editables: [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"],iframe')].filter((element) => element instanceof HTMLIFrameElement || visible(element)).slice(0, 80).map((element) => {
          const rect = element instanceof HTMLElement ? element.getBoundingClientRect() : { width: 0, height: 0 };
          return { tag: element.tagName, type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || element.getAttribute('aria-label'), className: String(element.className || '').slice(0, 180), contenteditable: element.getAttribute('contenteditable'), width: Math.round(rect.width), height: Math.round(rect.height), text: normalize(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent).slice(0, 100), outerHTML: element.outerHTML.slice(0, 1000), parentOuterHTML: element.parentElement?.parentElement?.parentElement?.outerHTML?.slice(0, 3000) || '' };
        }),
        buttons: [...document.querySelectorAll('button,[role="button"]')].filter(visible).slice(0, 100).map((element) => ({ text: normalize(element.textContent).slice(0, 80), className: String(element.className || '').slice(0, 180), ariaLabel: element.getAttribute('aria-label'), title: element.getAttribute('title'), dataAttrs: [...element.attributes].filter((attribute) => attribute.name.startsWith('data-')).slice(0, 8).map((attribute) => [attribute.name, attribute.value]), outerHTML: element.outerHTML.slice(0, 1200), disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' })),
        dialogs: [...document.querySelectorAll('[role="dialog"],[class*="message"],[class*="Message"],[class*="modal"],[class*="Modal"]')].filter(visible).slice(0, 20).map((element) => ({ text: normalize(element.textContent).slice(0, 300), className: String(element.className || '').slice(0, 200), outerHTML: element.outerHTML.slice(0, 2000) })),
        storage: Object.keys(localStorage).slice(0, 100).map((key) => ({ key, length: String(localStorage.getItem(key) || '').length, valueStart: String(localStorage.getItem(key) || '').slice(0, 300) })),
      };
    })()`);
    const attention = await detectVisibleAttention(managed.view.webContents, platform);
    if (attention) await this.promoteBackgroundForAttention(managed, attention);
    return { ...this.platformStatus(platform), ...details, attentionRequired: attention };
  }

  status(): DesktopStatus {
    return {
      version: this.version,
      pid: process.pid,
      ready: true,
      busy: this.isBusy(),
      activePlatform: this.activePlatform,
      executingPlatform: this.executingPlatform,
      windowState: this.window.isMinimized() ? 'minimized' : this.window.isVisible() ? 'visible' : 'hidden',
      attentionRequired: this.attentionRequired,
      platforms: PLATFORMS.map((platform) => this.platformStatus(platform)),
    };
  }

  isBusy(): boolean {
    return this.pendingOperations > 0;
  }

  async flushStorage(): Promise<void> {
    const managed = [...this.views.values(), ...(this.background ? [this.background] : [])];
    await Promise.all(managed.flatMap(({ platform, partition }) => [partition.flushStorageData(), snapshotPlatformCookies(partition, platform)]));
  }

  dispose(): void {
    this.executionHost.destroy();
  }

  private async createView(platform: Platform, host: ViewHost): Promise<ManagedView> {
    const useMinimalBrowserEnvironment = platform === 'toutiao' || platform === 'netease';
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:geo-publisher-${platform}`,
        contextIsolation: false,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        enableWebSQL: false,
        preload: useMinimalBrowserEnvironment ? undefined : join(__dirname, '..', 'stealth-preload.cjs'),
      },
    });
    const partition = session.fromPartition(`persist:geo-publisher-${platform}`);
    if (useMinimalBrowserEnvironment) setupStealthUserAgent(partition);
    else setupStealthSession(partition);
    await restorePlatformCookies(partition, platform);
    const managed: ManagedView = { platform, view, partition, host, loading: false, lastUsedAt: Date.now() };
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (!managed.loading && url !== managed.view.webContents.getURL()) void this.loadUrl(managed, url);
      return { action: 'deny' };
    });
    view.webContents.on('did-start-loading', () => { managed.loading = true; });
    view.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(`[${platform}] renderer: ${message}`); });
    view.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[${platform}] renderer process gone: ${details.reason}`);
      const retained = this.background === managed || this.views.get(platform) === managed;
      if (retained && !view.webContents.isDestroyed()) setTimeout(() => void this.loadUrl(managed, view.webContents.getURL() || PLATFORM_URLS[platform]), 800);
    });
    view.webContents.on('dom-ready', () => this.restoreManagedView(managed));
    view.webContents.on('did-stop-loading', () => {
      managed.loading = false;
      this.restoreManagedView(managed);
      void partition.flushStorageData();
      void snapshotPlatformCookies(partition, platform).catch(() => undefined);
    });
    partition.cookies.on('changed', () => {
      void partition.flushStorageData();
      void snapshotPlatformCookies(partition, platform).catch(() => undefined);
    });
    if (!useMinimalBrowserEnvironment) setupStealthInjection(view.webContents);
    return managed;
  }

  private async openBackground(platform: Platform): Promise<ManagedView> {
    if (this.background && this.background.platform !== platform) await this.closeBackground();
    if (!this.background) {
      this.background = await this.createView(platform, 'background');
      this.attachBackground(this.background);
      await this.loadUrl(this.background, PLATFORM_URLS[platform]);
      await this.executionHost.prepare(this.background.view.webContents);
    } else {
      this.attachBackground(this.background);
      await this.executionHost.prepare(this.background.view.webContents);
    }
    this.executingPlatform = platform;
    return this.background;
  }

  private attachInteractive(managed: ManagedView): void {
    if (this.activePlatform) {
      const active = this.views.get(this.activePlatform);
      if (active && active !== managed) {
        active.lastUsedAt = Date.now();
        active.view.webContents.setBackgroundThrottling(true);
        this.window.contentView.removeChildView(active.view);
      }
    }
    this.window.contentView.addChildView(managed.view);
    managed.host = 'interactive';
    managed.lastUsedAt = Date.now();
    managed.view.webContents.setBackgroundThrottling(false);
    managed.view.setVisible(true);
    managed.view.setBounds(this.interactiveViewBounds());
    this.activePlatform = managed.platform;
  }

  private attachBackground(managed: ManagedView): void {
    managed.host = 'background';
    managed.lastUsedAt = Date.now();
    this.executionHost.attach(managed.view);
  }

  private async promoteBackground(platform: Platform): Promise<void> {
    const managed = this.background;
    if (!managed || managed.platform !== platform) return;
    const existing = this.views.get(platform);
    if (existing) this.closeInteractiveView(existing);
    this.evictIdleInteractiveView(platform);
    this.executionHost.detach(managed.view);
    this.background = null;
    this.executingPlatform = null;
    this.views.set(platform, managed);
    this.attachInteractive(managed);
  }

  private async closeBackground(): Promise<void> {
    const managed = this.background;
    if (!managed) return;
    this.executionHost.detach(managed.view);
    this.background = null;
    this.executingPlatform = null;
    await managed.partition.flushStorageData();
    await snapshotPlatformCookies(managed.partition, managed.platform).catch(() => undefined);
    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close({ waitForBeforeUnload: false });
  }

  private closeInteractiveView(managed: ManagedView): void {
    if (this.activePlatform === managed.platform) {
      this.window.contentView.removeChildView(managed.view);
      this.activePlatform = null;
    }
    this.views.delete(managed.platform);
    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close({ waitForBeforeUnload: false });
  }

  private evictIdleInteractiveView(requestedPlatform: Platform): void {
    if (this.views.size < MAX_RESIDENT_INTERACTIVE_VIEWS) return;
    const candidate = pickEvictionCandidate([...this.views.values()].map(({ platform, lastUsedAt }) => ({ platform, lastUsedAt })), this.activePlatform, requestedPlatform);
    if (!candidate) return;
    const managed = this.views.get(candidate);
    if (managed) this.closeInteractiveView(managed);
  }

  private async promoteForAttention(managed: ManagedView, error: unknown): Promise<AttentionRequired | null> {
    const attention = attentionFromError(managed.platform, error, managed.view.webContents.getURL()) || await detectVisibleAttention(managed.view.webContents, managed.platform);
    if (attention) await this.promoteBackgroundForAttention(managed, attention);
    return attention;
  }

  private async promoteForVisibleAttention(managed: ManagedView, result: PublishResult): Promise<void> {
    const attention = await detectVisibleAttention(managed.view.webContents, managed.platform);
    if (attention) await this.promoteBackgroundForAttention(managed, attention);
    else if (/验证码|验证|登录失效|重新登录|账号异常|风控/.test(result.message)) {
      await this.promoteBackgroundForAttention(managed, { platform: managed.platform, code: 'RISK_CONTROL_REQUIRED', message: `RISK_CONTROL_REQUIRED: ${result.message}`, url: result.url });
    }
  }

  private async promoteBackgroundForAttention(managed: ManagedView, attention: AttentionRequired): Promise<void> {
    if (this.background === managed) await this.promoteBackground(managed.platform);
    this.attentionRequired = attention;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    this.onAttentionRequired(attention);
  }

  private async captureFillEvidence(managed: ManagedView, result: any): Promise<unknown> {
    if (managed.platform === 'sohu') {
      const settingsScreenshotPath = await this.captureEvidence(managed, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => { const editor = document.querySelector('.ql-editor[contenteditable="true"]'); if (!(editor instanceof HTMLElement)) return false; editor.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ...result, screenshotPath: await this.captureEvidence(managed, 'fill-content'), settingsScreenshotPath };
    }
    if (managed.platform === 'toutiao') {
      const settingsScreenshotPath = await this.captureEvidence(managed, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
        const single = [...document.querySelectorAll('label,[role="radio"],.byte-radio,.semi-radio')].filter(visible).find((element) => normalize(element.textContent) === '单图');
        let root = single instanceof HTMLElement ? single.parentElement : null;
        for (let depth = 0; root && depth < 12; depth += 1) { const text = normalize(root.textContent); if (text.includes('展示封面') && text.includes('无封面')) break; root = root.parentElement; }
        if (!(root instanceof HTMLElement)) return false; root.scrollIntoView({ block: 'center', inline: 'nearest' }); return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ...result, screenshotPath: await this.captureEvidence(managed, 'fill-cover'), settingsScreenshotPath };
    }
    return { ...result, screenshotPath: await this.captureEvidence(managed, 'fill') };
  }

  private platformStatus(platform: Platform): PlatformStatus {
    const interactive = this.views.get(platform);
    const background = this.background?.platform === platform;
    const created = Boolean(interactive || background);
    const attached = this.activePlatform === platform;
    const managed = this.executingPlatform === platform && background
      ? this.background
      : interactive || (background ? this.background : undefined);
    return {
      platform, created, attached, runtimeState: platformRuntimeState(created, attached, background), loginState: 'not_checked',
      statusNote: 'active 表示显示在主窗口；background 表示后台任务页，二者都不能用于判断登录状态。',
      loading: managed?.loading ?? false, url: managed?.view.webContents.getURL() ?? '', title: managed?.view.webContents.getTitle() ?? '',
    };
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
      this.restoreManagedView(managed);
    }
  }

  private restoreManagedView(managed: ManagedView): void {
    if (managed.host === 'background' && this.background === managed) this.executionHost.restore(managed.view);
    if (managed.host === 'interactive' && this.activePlatform === managed.platform) {
      managed.view.setVisible(true);
      managed.view.setBounds(this.interactiveViewBounds());
    }
  }

  private interactiveViewBounds(): { x: number; y: number; width: number; height: number } {
    const [width = 920, height = 640] = this.window.getContentSize();
    return { x: 220, y: 56, width: Math.max(320, width - 220), height: Math.max(240, height - 56) };
  }

  private async captureEvidence(managed: ManagedView, stage: string): Promise<string> {
    const directory = join(evidenceDirectory(), new Date().toISOString().slice(0, 10));
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-${managed.platform}-${stage}.png`);
    const image = await managed.view.webContents.capturePage();
    await writeFile(path, image.toPNG());
    return path;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations += 1;
    const previous = this.operationTail;
    let release: () => void = () => {};
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      this.pendingOperations -= 1;
      this.executingPlatform = null;
      release();
    }
  }
}
