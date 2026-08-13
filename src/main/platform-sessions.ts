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
import { renderArticleDocument, type ArticleDocument } from '../shared/article-document.js';
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
const OPERATION_TIMEOUT_MS = 4 * 60 * 1000;

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

export function projectPartitionName(projectId: string, platform: Platform): string {
  return `persist:geo-publisher-${projectId}-${platform}`;
}

function originalErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? null;
}

async function withEvidenceTimeout<T>(operation: Promise<T>, timeoutMs = 1_500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('EVIDENCE_CAPTURE_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class OperationTimeoutError extends Error {
  readonly details: unknown;

  constructor(details: unknown) {
    super('PLATFORM_OPERATION_TIMEOUT: 平台页面在 4 分钟内没有完成，请检查网络或重新登录后再试');
    this.details = details;
  }
}

export async function withOperationDeadline<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<unknown>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      void onTimeout().then(
        (details) => reject(new OperationTimeoutError(details)),
        () => reject(new OperationTimeoutError(null)),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
  private readonly executionHost: BackgroundExecutionHost;
  private background: ManagedView | null = null;
  private activePlatform: Platform | null = null;
  private executingPlatform: Platform | null = null;
  private attentionRequired: AttentionRequired | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;
  private uiOverlayOpen = false;
  private projectId: string | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly version: string,
    private readonly onAttentionRequired: (attention: AttentionRequired) => void = () => undefined,
    private readonly onBusyChanged: (busy: boolean) => void = () => undefined,
  ) {
    this.executionHost = new BackgroundExecutionHost();
  }

  currentProjectId(): string | null { return this.projectId; }

  async selectProject(projectId: string): Promise<void> {
    if (this.isBusy()) throw new Error('PUBLISHER_BUSY: 发布任务运行中，暂时不能切换客户项目');
    if (this.projectId === projectId) return;
    await this.closeBackground();
    for (const managed of [...this.views.values()]) this.closeInteractiveView(managed);
    this.projectId = projectId;
    this.activePlatform = null;
    this.attentionRequired = null;
  }

  async clearProject(): Promise<void> {
    if (this.isBusy()) throw new Error('PUBLISHER_BUSY: 发布任务运行中，暂时不能切换客户项目');
    await this.closeBackground();
    for (const managed of [...this.views.values()]) this.closeInteractiveView(managed);
    this.projectId = null;
    this.activePlatform = null;
    this.attentionRequired = null;
  }

  ensureProject(projectId?: string): string {
    if (!this.projectId) throw new Error('PROJECT_REQUIRED: 请先在 GEO Publisher 中新建并选择客户项目');
    if (projectId && projectId !== this.projectId) throw new Error('PROJECT_CONTEXT_CHANGED: 当前客户项目已切换，请重新生成文章后再发布');
    return this.projectId;
  }

  async open(platform: Platform): Promise<PlatformStatus> {
    this.ensureProject();
    if (this.isBusy()) {
      if (this.executingPlatform === platform && this.background) {
        this.showRunningPlatform(this.background);
        return this.platformStatus(platform);
      }
      throw new Error('PUBLISHER_BUSY: 发布任务运行中，请等待任务完成后再打开平台页面');
    }
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

  setUiOverlayOpen(open: boolean): void {
    this.uiOverlayOpen = open;
    if (!this.activePlatform) return;
    const managed = this.views.get(this.activePlatform);
    if (!managed) return;
    managed.view.setVisible(!open);
    if (!open) managed.view.setBounds(this.interactiveViewBounds());
  }

  async fillDraft(platform: Platform, document: ArticleDocument, coverPath: string): Promise<unknown> {
    this.ensureProject();
    return await this.runExclusive(() => this.fillDraftInternal(platform, document, coverPath));
  }

  private async fillDraftInternal(platform: Platform, document: ArticleDocument, coverPath: string): Promise<unknown> {
    const keepVisible = this.window.isVisible() && !this.window.isMinimized();
    let managed = await this.openBackground(platform);
    // If GEO Publisher is already open, show the platform that is running.
    // Hidden or minimized jobs stay on the private execution host so they do
    // not activate the customer's foreground application.
    if (keepVisible) {
      await this.promoteBackground(platform);
      managed = this.views.get(platform) || managed;
      this.executingPlatform = platform;
      managed.view.webContents.focus();
    }
    const rendered = renderArticleDocument(document, platform);
    try {
      const result = platform === 'baijia'
        ? await fillBaijiaDraft(managed.view.webContents, document.title, rendered.html, coverPath)
        : platform === 'toutiao'
          ? await fillToutiaoDraft(managed.view.webContents, document.title, rendered.html, coverPath)
          : platform === 'zhihu'
            ? await fillZhihuDraft(managed.view.webContents, document.title, rendered.html)
            : platform === 'penguin'
              ? await fillPenguinDraft(managed.view.webContents, document.title, rendered.html, document.tags)
              : platform === 'sohu'
                ? await fillSohuDraft(managed.view.webContents, document.title, rendered.html)
                : await fillNeteaseDraft(managed.view.webContents, document.title, rendered.html, coverPath);
      return await this.captureFillEvidence(managed, { ...result, structure: rendered.structuralExpectations });
    } catch (error) {
      const attention = await this.promoteForAttention(managed, error);
      if (attention) throw new AttentionRequiredError(attention, originalErrorCode(error));
      throw error;
    }
  }

  async publishDraft(platform: Platform, document: ArticleDocument, coverPath: string): Promise<unknown> {
    this.ensureProject();
    return await this.runExclusive(async () => {
      const fill = await this.fillDraftInternal(platform, document, coverPath);
      const managed = this.background || this.views.get(platform);
      if (!managed || managed.platform !== platform) throw new Error(`PUBLISH_VIEW_MISSING: ${platform} 发布页面不存在`);
      try {
        const result = await publishFilledDraft(managed.view.webContents, platform, document.title, renderArticleDocument(document, platform).html);
        const screenshotPath = await this.captureEvidence(managed, `publish-${result.status}`);
        if (result.status === 'action_required') await this.promoteForVisibleAttention(managed, result);
        if (result.status === 'success' && this.background) await this.closeBackground();
        return { fill, ...result, screenshotPath };
      } catch (error) {
        const attention = await this.promoteForAttention(managed, error);
        if (attention) throw new AttentionRequiredError(attention, originalErrorCode(error));
        throw error;
      }
    });
  }

  async inspect(platform: Platform): Promise<PlatformStatus & { textStart: string; controls: unknown[]; editables: unknown[]; buttons: unknown[]; dialogs: unknown[]; storageEntryCount: number; attentionRequired: AttentionRequired | null }> {
    this.ensureProject();
    return await this.runExclusive(() => this.inspectInternal(platform));
  }

  private async inspectInternal(platform: Platform): Promise<PlatformStatus & { textStart: string; controls: unknown[]; editables: unknown[]; buttons: unknown[]; dialogs: unknown[]; storageEntryCount: number; attentionRequired: AttentionRequired | null }> {
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
        // Diagnostics must never return cookie-like or session data to a CLI/agent log.
        // Storage count preserves a basic page-health signal without exposing names or values.
        storageEntryCount: Object.keys(localStorage).length,
      };
    })()`);
    const attention = await detectVisibleAttention(managed.view.webContents, platform);
    if (attention) this.recordAttention(attention);
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
      currentProject: null,
      attentionRequired: this.attentionRequired,
      platforms: PLATFORMS.map((platform) => this.platformStatus(platform)),
    };
  }

  isBusy(): boolean {
    return this.pendingOperations > 0;
  }

  async flushStorage(): Promise<void> {
    const managed = [...this.views.values(), ...(this.background ? [this.background] : [])];
    const projectId = this.projectId;
    if (!projectId) return;
    await Promise.all(managed.flatMap(({ platform, partition }) => [partition.flushStorageData(), snapshotPlatformCookies(partition, projectId, platform)]));
  }

  dispose(): void {
    this.executionHost.destroy();
  }

  private async createView(platform: Platform, host: ViewHost): Promise<ManagedView> {
    const projectId = this.ensureProject();
    const useMinimalBrowserEnvironment = platform === 'toutiao' || platform === 'netease';
    const view = new WebContentsView({
      webPreferences: {
        partition: projectPartitionName(projectId, platform),
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
    const partition = session.fromPartition(projectPartitionName(projectId, platform));
    if (useMinimalBrowserEnvironment) setupStealthUserAgent(partition);
    else setupStealthSession(partition);
    await restorePlatformCookies(partition, projectId, platform);
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
      void snapshotPlatformCookies(partition, projectId, platform).catch(() => undefined);
    });
    partition.cookies.on('changed', () => {
      void partition.flushStorageData();
      void snapshotPlatformCookies(partition, projectId, platform).catch(() => undefined);
    });
    if (!useMinimalBrowserEnvironment) setupStealthInjection(view.webContents);
    return managed;
  }

  private async openBackground(platform: Platform): Promise<ManagedView> {
    if (this.background && this.background.platform !== platform) await this.closeBackground();
    if (!this.background) {
      const interactive = this.views.get(platform);
      if (interactive) {
        if (this.activePlatform === platform) {
          this.window.contentView.removeChildView(interactive.view);
          this.activePlatform = null;
        }
        this.views.delete(platform);
        this.background = interactive;
        this.attachBackground(interactive);
      } else {
        this.background = await this.createView(platform, 'background');
        this.attachBackground(this.background);
        await this.loadUrl(this.background, PLATFORM_URLS[platform]);
      }
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
    managed.view.setVisible(!this.uiOverlayOpen);
    managed.view.setBounds(this.interactiveViewBounds());
    this.activePlatform = managed.platform;
  }

  private showRunningPlatform(managed: ManagedView): void {
    if (managed.host === 'interactive' && this.activePlatform === managed.platform) return;
    this.executionHost.detach(managed.view);
    this.window.contentView.addChildView(managed.view);
    managed.host = 'interactive';
    managed.view.webContents.setBackgroundThrottling(false);
    managed.view.setVisible(!this.uiOverlayOpen);
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
    if (managed.host === 'interactive' && this.activePlatform === managed.platform) {
      this.window.contentView.removeChildView(managed.view);
      this.activePlatform = null;
    }
    this.background = null;
    this.executingPlatform = null;
    await managed.partition.flushStorageData();
    if (this.projectId) await snapshotPlatformCookies(managed.partition, this.projectId, managed.platform).catch(() => undefined);
    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close({ waitForBeforeUnload: false });
  }

  private async abortTimedOutBackgroundOperation(): Promise<{ platform: Platform | null; url: string | null; screenshotPath: string | null }> {
    const managed = this.background;
    const details = {
      platform: managed?.platform ?? null,
      url: managed?.view.webContents.getURL() ?? null,
      screenshotPath: managed ? await this.captureTimedOutEvidence(managed) : null,
    };
    await this.closeBackground();
    return details;
  }

  private async captureTimedOutEvidence(managed: ManagedView): Promise<string | null> {
    let timeout: NodeJS.Timeout | undefined;
    const evidence = this.captureEvidence(managed, 'operation-timeout').catch(() => null);
    const fallback = new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 1_500); });
    try {
      return await Promise.race([evidence, fallback]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
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
    if (attention) this.recordAttention(attention);
    return attention;
  }

  private async promoteForVisibleAttention(managed: ManagedView, result: PublishResult): Promise<void> {
    const attention = await detectVisibleAttention(managed.view.webContents, managed.platform);
    if (attention) this.recordAttention(attention);
    else if (/验证码|验证|登录失效|重新登录|账号异常|风控/.test(result.message)) {
      this.recordAttention({ platform: managed.platform, code: 'RISK_CONTROL_REQUIRED', message: `RISK_CONTROL_REQUIRED: ${result.message}`, url: result.url });
    }
  }

  private recordAttention(attention: AttentionRequired): void {
    // Background jobs must never activate the app. WorkBuddy receives the
    // structured error immediately; the user can later open the platform
    // page from GEO Publisher to complete any required login or verification.
    this.attentionRequired = attention;
    this.onAttentionRequired(attention);
  }

  private async captureFillEvidence(managed: ManagedView, result: any): Promise<unknown> {
    if (managed.platform === 'baijia') {
      const settingsScreenshotPath = await this.captureEvidence(managed, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => {
        const title = document.querySelector('[data-testid="news-title-input"] [contenteditable="true"],.FeEditorApp-_9ddb7e475b559749-editor[contenteditable="true"]');
        if (!(title instanceof HTMLElement)) return false;
        title.scrollIntoView({ block: 'start', inline: 'nearest' });
        window.scrollBy({ top: -100, behavior: 'instant' });
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ...result, screenshotPath: await this.captureEvidence(managed, 'fill-content'), settingsScreenshotPath };
    }
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
    if (managed.platform === 'zhihu') {
      const settingsScreenshotPath = await this.captureEvidence(managed, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => {
        const title = document.querySelector('textarea[placeholder*="请输入标题"]');
        const editor = document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        const target = title instanceof HTMLElement ? title : editor;
        if (!(target instanceof HTMLElement)) return false;
        target.scrollIntoView({ block: 'start', inline: 'nearest' });
        window.scrollBy({ top: -120, behavior: 'instant' });
        return true;
      })()`);
      // Close any toolbar popover left open by block formatting so the
      // evidence image reflects the actual article instead of covering it.
      managed.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      managed.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ...result, screenshotPath: await this.captureEvidence(managed, 'fill-content'), settingsScreenshotPath };
    }
    if (managed.platform === 'penguin') {
      const settingsScreenshotPath = await this.captureEvidence(managed, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => {
        const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
        const title = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
          .filter(visible).find((element) => String(element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '').includes('标题'));
        if (!(title instanceof HTMLElement)) return false;
        title.scrollIntoView({ block: 'start', inline: 'nearest' });
        window.scrollBy({ top: -100, behavior: 'instant' });
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ...result, screenshotPath: await this.captureEvidence(managed, 'fill-content'), settingsScreenshotPath };
    }
    if (managed.platform === 'netease') {
      const settingsScreenshotPath = await this.captureEvidence(managed, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => {
        const title = document.querySelector('textarea.netease-textarea,textarea[placeholder*="标题"]');
        if (!(title instanceof HTMLElement)) return false;
        title.scrollIntoView({ block: 'start', inline: 'nearest' });
        window.scrollBy({ top: -100, behavior: 'instant' });
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ...result, screenshotPath: await this.captureEvidence(managed, 'fill-content'), settingsScreenshotPath };
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
      managed.view.setVisible(!this.uiOverlayOpen);
      managed.view.setBounds(this.interactiveViewBounds());
    }
  }

  private interactiveViewBounds(): { x: number; y: number; width: number; height: number } {
    const [width = 920, height = 640] = this.window.getContentSize();
    return { x: 220, y: 56, width: Math.max(320, width - 220), height: Math.max(240, height - 56) };
  }

  private async captureEvidence(managed: ManagedView, stage: string): Promise<string | null> {
    const directory = join(evidenceDirectory(this.projectId ?? undefined), new Date().toISOString().slice(0, 10));
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-${managed.platform}-${stage}.png`);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const image = await withEvidenceTimeout(managed.view.webContents.capturePage());
        await writeFile(path, image.toPNG());
        return path;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Hidden BrowserWindow surfaces can reject capturePage. CDP captures the
    // renderer without requiring a foreground display surface.
    const debuggerApi = managed.view.webContents.debugger;
    const attachedHere = !debuggerApi.isAttached();
    try {
      if (attachedHere) debuggerApi.attach('1.3');
      const response = await withEvidenceTimeout(debuggerApi.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
      })) as { data?: string };
      if (response.data) {
        await writeFile(path, Buffer.from(response.data, 'base64'));
        return path;
      }
    } catch (error) {
      lastError = error;
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }

    // Evidence is diagnostic only; it must never prevent a valid publish.
    void lastError;
    return null;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations += 1;
    this.onBusyChanged(true);
    const previous = this.operationTail;
    let release: () => void = () => {};
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const task = operation();
    try {
      // Closing the hidden WebContents stops a stalled renderer from acting
      // after the CLI caller has already received its timeout result.
      return await withOperationDeadline(task, OPERATION_TIMEOUT_MS, () => this.abortTimedOutBackgroundOperation());
    } finally {
      this.pendingOperations -= 1;
      this.executingPlatform = null;
      this.onBusyChanged(this.pendingOperations > 0);
      release();
    }
  }
}
