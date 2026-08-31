import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { BrowserWindow, session, WebContentsView } from 'electron';
import type { DesktopStatus, Platform, PlatformStatus, PublishTaskAction, PublishTaskPhase, PublishTaskSnapshot } from '../shared/protocol.js';
import { PLATFORMS } from '../shared/protocol.js';
import { fillBaijiaDraft } from './baijia-adapter.js';
import { fillPenguinDraft } from './penguin-adapter.js';
import { fillSohuDraft } from './sohu-adapter.js';
import { evidenceDirectory } from './runtime-paths.js';
import { reportError } from './logging.js';
import { setupStealthInjection, setupStealthSession, setupStealthUserAgent } from './stealth.js';
import { fillToutiaoDraft } from './toutiao-adapter.js';
import { fillZhihuDraft } from './zhihu-adapter.js';
import { fillNeteaseDraft } from './netease-adapter.js';
import { publishFilledDraft } from './publish-adapter.js';
import { restorePlatformCookies, snapshotPlatformCookies } from './cookie-vault.js';
import { BrowserAutomationDriver, runWithBrowserAutomationDriver } from './browser-automation-driver.js';
import { automationViewportForView } from './worker-window-layout.js';
import { PublishTaskJournalStore } from './publish-task-journal.js';
import { captureSuccessfulEvidence, captureUncertainEvidence } from './evidence-policy.js';
import { PublishTaskHistoryStore, taskStatusForResult } from './publish-task-history.js';
import { concealWorkerWindow, revealWorkerWindow } from './worker-window-visibility.js';
import {
  appendDiagnosticConsoleEvent,
  captureFailureDiagnostic,
  exportDiagnosticBundle,
  removeTaskDiagnostic,
  type DiagnosticConsoleEvent,
} from './diagnostic-bundle.js';

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
  recoveryTimer: NodeJS.Timeout | null;
  consoleEvents: DiagnosticConsoleEvent[];
}

type TaskAction = 'open' | 'inspect' | 'fill' | 'publish';
type TaskPhase = NonNullable<DesktopStatus['activeTask']>['phase'];

interface ActiveTask {
  taskId: string;
  action: PublishTaskAction;
  platform: Platform;
  phase: PublishTaskPhase;
  title?: string;
  startedAt: number;
  deadlineAt: number;
  snapshot?: PublishTaskSnapshot;
}

interface CookieSubscription {
  session: Electron.Session;
  listener: () => void;
  snapshotTimer: NodeJS.Timeout | null;
}

/** One live platform is enough for the serial publisher and avoids six renderers idling in memory. */
const MAX_RESIDENT_PLATFORM_VIEWS = 1;
const RECENT_TASK_LIMIT = 20;
const IDLE_VIEW_DISPOSAL_MS = 3 * 60 * 1000;
const TASK_TIMEOUT_MS: Record<TaskAction, number> = {
  open: 135_000,
  inspect: 135_000,
  fill: 210_000,
  publish: 270_000,
};
const NAVIGATION_READY_TIMEOUT_MS = 30_000;

export function shouldUseWindowsEditorForeground(
  platform: Platform,
  action: TaskAction,
  runtimePlatform = process.platform,
): boolean {
  return runtimePlatform === 'win32'
    && (platform === 'zhihu' || platform === 'sohu' || platform === 'netease')
    && (action === 'fill' || action === 'publish');
}

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

export function platformRuntimeState(created: boolean, attached: boolean): PlatformStatus['runtimeState'] {
  if (attached) return 'active';
  return created ? 'resident' : 'not_loaded';
}

export interface EvidenceCaptureResult {
  screenshotPath: string | null;
  screenshotWarning: string | null;
}

export interface PlatformSessionsOptions {
  layout?: 'dashboard' | 'execution';
  tabBarHeight?: number;
}

export async function captureEvidenceBestEffort(
  operation: () => Promise<string>,
  platform: Platform,
  stage: string,
): Promise<EvidenceCaptureResult> {
  try {
    return { screenshotPath: await operation(), screenshotWarning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning = `EVIDENCE_CAPTURE_FAILED: ${platform}/${stage}: ${message}`;
    reportError(warning);
    return { screenshotPath: null, screenshotWarning: warning };
  }
}

function evidencePathFrom(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['screenshotPath', 'evidencePath', 'settingsScreenshotPath']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  for (const nested of Object.values(record)) {
    const path = evidencePathFrom(nested, depth + 1);
    if (path) return path;
  }
  return undefined;
}

function messageFromResult(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message) return record.message;
  if (typeof record.error === 'string' && record.error) return record.error;
  return undefined;
}

export class PlatformSessions {
  private readonly views = new Map<Platform, ManagedView>();
  private activePlatform: Platform | null = null;
  private activeTask: ActiveTask | null = null;
  private readonly cookieSubscriptions = new Map<Platform, CookieSubscription>();
  private readonly publishJournal = new PublishTaskJournalStore();
  private readonly taskHistory = new PublishTaskHistoryStore();
  private recentTasks: PublishTaskSnapshot[] = [];
  private idleViewDisposalTimer: NodeJS.Timeout | null = null;
  private automationRevealedWindow = false;
  private maintenance: Pick<NonNullable<DesktopStatus['resourceDiagnostics']>, 'evidenceBytes' | 'cacheBytes' | 'lastMaintenanceAt'> = {};

  constructor(
    private readonly window: BrowserWindow,
    private readonly version: string,
    private readonly options: PlatformSessionsOptions = {},
  ) {}

  async loadTaskHistory(): Promise<void> {
    // Older builds recorded a successful task when the user merely opened a
    // platform. Those records are not publishing history and must not appear
    // in the user-facing list after upgrade.
    await this.taskHistory.migrateLegacyActions();
    await this.taskHistory.prune();
    this.recentTasks = (await this.taskHistory.list(RECENT_TASK_LIMIT))
      .filter((task) => task.action === 'fill' || task.action === 'publish');
  }

  async clearCompletedTaskHistory(): Promise<void> {
    const records = await this.taskHistory.list(Number.MAX_SAFE_INTEGER);
    const evidenceRoot = `${resolve(evidenceDirectory())}${sep}`;
    await Promise.all(records
      .filter((record) => record.status !== 'running' && record.evidencePath)
      .map(async (record) => {
        const path = record.evidencePath;
        const resolvedPath = path ? resolve(path) : '';
        if (!resolvedPath.startsWith(evidenceRoot)) return;
        await rm(resolvedPath, { force: true }).catch(() => undefined);
      }));
    await Promise.all(records
      .filter((record) => record.status !== 'running' && record.diagnosticPath)
      .map(async (record) => await removeTaskDiagnostic(record.taskId)));
    await this.taskHistory.clearCompleted();
    await this.loadTaskHistory();
  }

  async exportTaskDiagnostic(taskId: string): Promise<{ path: string; fileName: string }> {
    const task = await this.taskHistory.get(taskId);
    if (!task || task.status === 'running') throw new Error('DIAGNOSTIC_TASK_NOT_FOUND: 找不到这条失败记录');
    return await exportDiagnosticBundle(task);
  }

  cancelIdleViewDisposal(): void {
    if (this.idleViewDisposalTimer) clearTimeout(this.idleViewDisposalTimer);
    this.idleViewDisposalTimer = null;
  }

  showWindow(): void {
    this.automationRevealedWindow = false;
    revealWorkerWindow(this.window, process.platform === 'win32');
    this.cancelIdleViewDisposal();
  }

  scheduleIdleViewDisposal(): void {
    this.cancelIdleViewDisposal();
    if (this.activeTask || this.window.isVisible() || this.views.size === 0) return;
    this.idleViewDisposalTimer = setTimeout(() => {
      this.idleViewDisposalTimer = null;
      if (this.activeTask || this.window.isVisible()) return;
      void this.flushStorage()
        .catch(() => undefined)
        .finally(() => {
          if (this.activeTask || this.window.isVisible()) return;
          for (const managed of [...this.views.values()]) this.disposeManagedView(managed);
        });
    }, IDLE_VIEW_DISPOSAL_MS);
  }

  async open(platform: Platform, mode: 'interactive' | 'background' = 'interactive'): Promise<PlatformStatus> {
    return await this.runExclusive('open', platform, async () => await this.openInternal(platform, mode));
  }

  private async openInternal(platform: Platform, mode: 'interactive' | 'background' = 'interactive'): Promise<PlatformStatus> {
    this.cancelIdleViewDisposal();
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
          backgroundThrottling: false,
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

      managed = { platform, view, partition: platformSession, loading: false, lastUsedAt: Date.now(), recoveryTimer: null, consoleEvents: [] };
      this.views.set(platform, managed);
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (managed && !managed.loading && url !== managed.view.webContents.getURL()) {
          void this.loadUrl(managed, url);
        }
        return { action: 'deny' };
      });
      view.webContents.on('did-start-loading', () => { if (managed) managed.loading = true; });
      view.webContents.on('console-message', (_event, level, message) => {
        if (managed) appendDiagnosticConsoleEvent(managed.consoleEvents, level, message);
        if (level >= 2) reportError(`[${platform}] renderer: ${message}`);
      });
      view.webContents.on('render-process-gone', (_event, details) => {
        reportError(`[${platform}] renderer process gone: ${details.reason}`);
        if (managed && this.activePlatform === platform && !managed.view.webContents.isDestroyed()) {
          if (managed.recoveryTimer) clearTimeout(managed.recoveryTimer);
          const expectedView = managed.view;
          managed.recoveryTimer = setTimeout(() => {
            const current = this.views.get(platform);
            if (!current || current.view !== expectedView || expectedView.webContents.isDestroyed()) return;
            void this.loadUrl(current, current.view.webContents.getURL() || PLATFORM_URLS[platform]);
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
      this.ensureCookieSubscription(platformSession, platform);

      // 设置反检测脚本注入（多时机注入确保生效）
      if (!useMinimalBrowserEnvironment) setupStealthInjection(view.webContents);

      this.attach(platform);
      this.setWindowMode(mode);
      await this.loadUrl(managed, PLATFORM_URLS[platform]);
    }
    if (this.activePlatform !== platform) this.attach(platform);
    this.setWindowMode(mode);
    return this.platformStatus(platform);
  }

  attach(platform: Platform): void {
    const managed = this.views.get(platform);
    if (!managed) throw new Error(`平台尚未创建：${platform}`);
    if (this.activePlatform) {
      const active = this.views.get(this.activePlatform);
      if (active) {
        active.lastUsedAt = Date.now();
        active.view.webContents.setBackgroundThrottling(false);
        active.view.setVisible(false);
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

  async fillDraft(platform: Platform, title: string, html: string, coverPath: string, tags: string[]): Promise<unknown> {
    return await this.runExclusive('fill', platform, () => this.fillDraftInternal(platform, title, html, coverPath, tags), title);
  }

  private async fillDraftInternal(
    platform: Platform,
    title: string,
    html: string,
    coverPath: string,
    tags: string[],
    taskDriver?: BrowserAutomationDriver,
  ): Promise<unknown> {
    await this.openInternal(platform, 'background');
    this.setTaskPhase('filling');
    const managed = this.views.get(platform);
    if (!managed) throw new Error(`${platform} 浏览器创建失败`);
    const driver = taskDriver ?? new BrowserAutomationDriver(managed.view.webContents, platform, {
      viewport: automationViewportForView(this.viewBounds()),
    });
    const fill = async () => await driver.action('draft.fill', async () => platform === 'baijia'
      ? await fillBaijiaDraft(managed.view.webContents, title, html, coverPath)
      : platform === 'toutiao'
        ? await fillToutiaoDraft(managed.view.webContents, title, html, coverPath)
        : platform === 'zhihu'
          ? await fillZhihuDraft(managed.view.webContents, title, html)
          : platform === 'penguin'
            ? await fillPenguinDraft(managed.view.webContents, title, html, tags)
            : platform === 'sohu'
              ? await fillSohuDraft(managed.view.webContents, title, html)
              : await fillNeteaseDraft(managed.view.webContents, title, html, coverPath), { captureOnFailure: true });
    const result = taskDriver ? await fill() : await runWithBrowserAutomationDriver(driver, fill);
    if (platform === 'sohu' && captureSuccessfulEvidence()) {
      const settingsEvidence = await this.captureEvidence(platform, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => { const editor = document.querySelector('.ql-editor[contenteditable="true"]'); if (!(editor instanceof HTMLElement)) return false; editor.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const evidence = await this.captureEvidence(platform, 'fill-content');
      return {
        ...result,
        ...evidence,
        settingsScreenshotPath: settingsEvidence.screenshotPath,
        settingsScreenshotWarning: settingsEvidence.screenshotWarning,
        automation: { actions: driver.results() },
      };
    }
    if (platform === 'sohu') {
      return { ...result, screenshotPath: null, screenshotWarning: null, automation: { actions: driver.results() } };
    }
    if (platform === 'toutiao' && captureSuccessfulEvidence()) {
      const settingsEvidence = await this.captureEvidence(platform, 'fill-settings');
      await managed.view.webContents.executeJavaScript(`(() => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
        const single = [...document.querySelectorAll('label,[role="radio"],.byte-radio,.semi-radio')].filter(visible).find((element) => normalize(element.textContent) === '单图');
        let root = single instanceof HTMLElement ? single.parentElement : null;
        for (let depth = 0; root && depth < 12; depth += 1) { const text = normalize(root.textContent); if (text.includes('展示封面') && text.includes('无封面')) break; root = root.parentElement; }
        if (!(root instanceof HTMLElement)) return false; root.scrollIntoView({ block: 'center', inline: 'nearest' }); return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const evidence = await this.captureEvidence(platform, 'fill-cover');
      return {
        ...result,
        ...evidence,
        settingsScreenshotPath: settingsEvidence.screenshotPath,
        settingsScreenshotWarning: settingsEvidence.screenshotWarning,
        automation: { actions: driver.results() },
      };
    }
    if (platform === 'toutiao') {
      return { ...result, screenshotPath: null, screenshotWarning: null, automation: { actions: driver.results() } };
    }
    const evidence = captureSuccessfulEvidence()
      ? await this.captureEvidence(platform, 'fill')
      : { screenshotPath: null, screenshotWarning: null };
    return { ...result, ...evidence, automation: { actions: driver.results() } };
  }

  async publishDraft(platform: Platform, title: string, html: string, coverPath: string, tags: string[]): Promise<unknown> {
    return await this.runExclusive('publish', platform, async () => {
      await this.openInternal(platform, 'background');
      const managed = this.views.get(platform);
      if (!managed) throw new Error(`PUBLISH_VIEW_MISSING: ${platform} 发布页面不存在`);
      let journal = await this.publishJournal.prepare({ platform, title, html, coverPath, tags });
      if (journal.state === 'success') {
        return { ...(journal.result as object), automation: { taskId: journal.taskId, reused: true, actions: [] } };
      }
      const driver = new BrowserAutomationDriver(managed.view.webContents, platform, {
        viewport: automationViewportForView(this.viewBounds()),
      });
      return await runWithBrowserAutomationDriver(driver, async () => {
        let irreversibleDispatched = false;
        const fill = await this.fillDraftInternal(platform, title, html, coverPath, tags, driver);
        this.setTaskPhase('pre_publish');
        const active = this.views.get(platform);
        if (!active) throw new Error(`PUBLISH_VIEW_MISSING: ${platform} 发布页面不存在`);
        const result = await driver.action('draft.publish', async () =>
          await publishFilledDraft(active.view.webContents, platform, title, html, {
          beforeIrreversibleClick: async () => {
            this.setTaskPhase('dispatching');
            journal = await this.publishJournal.update(journal, 'dispatching');
          },
          afterIrreversibleClick: async () => {
            this.setTaskPhase('dispatched');
            irreversibleDispatched = true;
            journal = await this.publishJournal.update(journal, 'dispatched');
          },
          }), { captureOnFailure: true });
        const state = result.status === 'success' ? 'success'
          : result.status === 'result_uncertain' ? 'result_uncertain' : 'action_required';
        this.setTaskPhase('reconciling');
        journal = await this.publishJournal.update(journal, state, result);
        const evidence = captureUncertainEvidence(result.status) || captureSuccessfulEvidence()
          ? await this.captureEvidence(platform, `publish-${result.status}`)
          : { screenshotPath: null, screenshotWarning: null };
        return {
          fill,
          ...result,
          ...evidence,
          automation: { taskId: journal.taskId, irreversibleDispatched, actions: driver.results() },
        };
      });
    }, title);
  }

  async inspect(platform: Platform): Promise<PlatformStatus & { textStart: string; controls: unknown[]; editables: unknown[]; buttons: unknown[]; dialogs: unknown[]; storage: unknown[] }> {
    return await this.runExclusive('inspect', platform, async () => await this.inspectInternal(platform));
  }

  private async inspectInternal(platform: Platform): Promise<PlatformStatus & { textStart: string; controls: unknown[]; editables: unknown[]; buttons: unknown[]; dialogs: unknown[]; storage: unknown[] }> {
    await this.openInternal(platform, 'background');
    const managed = this.views.get(platform);
    if (!managed) throw new Error(`PLATFORM_VIEW_MISSING: ${platform} 页面未能创建`);
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
      busy: this.isBusy(),
      activeTask: this.activeTask ? {
        taskId: this.activeTask.taskId,
        action: this.activeTask.action,
        platform: this.activeTask.platform,
        phase: this.activeTask.phase,
        ...(this.activeTask.title ? { title: this.activeTask.title } : {}),
        startedAt: new Date(this.activeTask.startedAt).toISOString(),
        deadlineAt: new Date(this.activeTask.deadlineAt).toISOString(),
      } : null,
      recentTasks: this.recentTasks,
      activePlatform: this.activePlatform,
      platforms: PLATFORMS.map((platform) => this.platformStatus(platform)),
      resourceDiagnostics: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        residentViews: this.views.size,
        cookieSubscriptions: this.cookieSubscriptions.size,
        ...this.maintenance,
      },
    };
  }

  isBusy(): boolean {
    return this.activeTask !== null;
  }

  async flushStorage(): Promise<void> {
    await Promise.all([...this.views.values()].flatMap(({ platform, partition }) => [
      partition.flushStorageData(),
      snapshotPlatformCookies(partition, platform),
    ]));
  }

  setResourceMaintenance(result: Pick<NonNullable<DesktopStatus['resourceDiagnostics']>, 'evidenceBytes' | 'cacheBytes' | 'lastMaintenanceAt'>): void {
    this.maintenance = result;
  }

  async dispose(): Promise<void> {
    this.cancelIdleViewDisposal();
    await this.flushStorage().catch(() => undefined);
    for (const managed of [...this.views.values()]) this.disposeManagedView(managed);
    for (const subscription of this.cookieSubscriptions.values()) {
      subscription.session.cookies.removeListener('changed', subscription.listener);
      if (subscription.snapshotTimer) clearTimeout(subscription.snapshotTimer);
    }
    this.cookieSubscriptions.clear();
    this.activeTask = null;
  }

  private platformStatus(platform: Platform): PlatformStatus {
    const managed = this.views.get(platform);
    const created = Boolean(managed);
    const attached = this.activePlatform === platform;
    return {
      platform,
      created,
      attached,
      runtimeState: platformRuntimeState(created, attached),
      loginState: 'not_checked',
      statusNote: 'created/attached 仅表示页面是否驻留和显示，不能用于判断登录；登录状态必须通过 inspect 检查实际页面',
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
    this.disposeManagedView(managed);
  }

  private async loadUrl(managed: ManagedView, url: string): Promise<void> {
    if (managed.loading) return;
    managed.loading = true;
    try {
      const contents = managed.view.webContents;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          contents.removeListener('dom-ready', ready);
          operation();
        };
        const ready = (): void => finish(resolve);
        const timeout = setTimeout(ready, NAVIGATION_READY_TIMEOUT_MS);
        contents.once('dom-ready', ready);
        void contents.loadURL(url)
          .then(() => finish(resolve))
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (/ERR_ABORTED \(-3\)/.test(message)) finish(resolve);
            else finish(() => reject(error));
          });
      });
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
    if (this.options.layout === 'execution') {
      const [width = 1440, height = 1000] = this.window.getContentSize();
      const tabBarHeight = Math.max(0, this.options.tabBarHeight ?? 0);
      return { x: 0, y: tabBarHeight, width: Math.max(1, width), height: Math.max(1, height - tabBarHeight) };
    }
    const [width = 920, height = 640] = this.window.getContentSize();
    return { x: 220, y: 56, width: Math.max(320, width - 220), height: Math.max(240, height - 56) };
  }

  private setWindowMode(mode: 'interactive' | 'background'): void {
    if (mode === 'interactive') {
      this.showWindow();
      return;
    }
    // Background work is described in the publishing center. The user can open
    // the live page at any time, without a browser window appearing over work.
  }

  private async captureEvidence(platform: Platform, stage: string): Promise<EvidenceCaptureResult> {
    return await captureEvidenceBestEffort(async () => {
      const managed = this.views.get(platform);
      if (!managed) throw new Error(`平台尚未创建：${platform}`);
      const directory = join(evidenceDirectory(), new Date().toISOString().slice(0, 10));
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${Date.now()}-${platform}-${stage}.png`);
      const image = await managed.view.webContents.capturePage();
      await writeFile(path, image.toPNG());
      return path;
    }, platform, stage);
  }

  private async runExclusive<T>(action: TaskAction, platform: Platform, operation: () => Promise<T>, title?: string): Promise<T> {
    if (this.activeTask) {
      const error = new Error(`TASK_BUSY: ${this.activeTask.action}/${this.activeTask.platform} 正在执行`) as Error & { details: unknown };
      error.details = {
        action: this.activeTask.action,
        platform: this.activeTask.platform,
        phase: this.activeTask.phase,
        startedAt: new Date(this.activeTask.startedAt).toISOString(),
        deadlineAt: new Date(this.activeTask.deadlineAt).toISOString(),
      };
      throw error;
    }
    const startedAt = Date.now();
    const shouldRecordHistory = action === 'fill' || action === 'publish';
    const snapshot = shouldRecordHistory
      ? await this.taskHistory.start({
          action,
          platform,
          phase: 'opening',
          ...(title ? { title } : {}),
          lastKnownUrl: this.platformStatus(platform).url || undefined,
        })
      : undefined;
    if (snapshot) this.upsertRecentTask(snapshot);
    this.activeTask = {
      taskId: snapshot?.taskId || randomUUID(),
      action,
      platform,
      phase: 'opening',
      ...(title ? { title } : {}),
      startedAt,
      deadlineAt: startedAt + TASK_TIMEOUT_MS[action],
      ...(snapshot ? { snapshot } : {}),
    };
    const revealForAutomation = shouldUseWindowsEditorForeground(platform, action);
    const restoreHiddenWindow = revealForAutomation && !this.window.isVisible();
    if (revealForAutomation) {
      this.automationRevealedWindow = restoreHiddenWindow;
      revealWorkerWindow(this.window, true);
    }
    try {
      const result = await operation();
      await this.finishActiveTask(taskStatusForResult(result), result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.match(/^([A-Z][A-Z0-9_]+):/)?.[1];
      const status = code === 'RESULT_UNCERTAIN' ? 'result_uncertain' : 'failed';
      const managed = this.views.get(platform);
      const evidence = this.activeTask?.snapshot
        ? await this.captureEvidence(platform, 'failure')
        : { screenshotPath: null, screenshotWarning: null };
      let diagnosticPath: string | undefined;
      if (this.activeTask?.snapshot) {
        try {
          diagnosticPath = await captureFailureDiagnostic({
            task: { ...this.activeTask.snapshot, phase: this.activeTask.phase },
            errorMessage: message,
            ...(code ? { errorCode: code } : {}),
            ...(managed ? { webContents: managed.view.webContents } : {}),
            window: this.window,
            version: this.version,
            consoleEvents: managed?.consoleEvents || [],
            automationActions: error && typeof error === 'object'
              ? (error as { automationActions?: unknown }).automationActions
              : undefined,
            ...(evidence.screenshotPath ? { evidencePath: evidence.screenshotPath } : {}),
          });
        } catch (diagnosticError) {
          reportError('Failure diagnostic capture failed:', diagnosticError);
        }
      }
      await this.finishActiveTask(status, undefined, message, code, evidence.screenshotPath || undefined, diagnosticPath);
      throw error;
    } finally {
      if (restoreHiddenWindow && this.automationRevealedWindow) {
        concealWorkerWindow(this.window, true);
        this.automationRevealedWindow = false;
      }
      this.activeTask = null;
      this.scheduleIdleViewDisposal();
    }
  }

  private setTaskPhase(phase: TaskPhase): void {
    if (!this.activeTask) return;
    this.activeTask.phase = phase;
    if (this.activeTask.snapshot) {
      this.activeTask.snapshot = { ...this.activeTask.snapshot, phase };
      this.upsertRecentTask(this.activeTask.snapshot);
    }
  }

  private async finishActiveTask(
    status: PublishTaskSnapshot['status'],
    result?: unknown,
    errorMessage?: string,
    errorCode?: string,
    explicitEvidencePath?: string,
    diagnosticPath?: string,
  ): Promise<void> {
    const task = this.activeTask;
    if (!task?.snapshot) return;
    const finishedAt = new Date().toISOString();
    const evidencePath = explicitEvidencePath || evidencePathFrom(result);
    const message = errorMessage || messageFromResult(result);
    const next = await this.taskHistory.update(task.snapshot, {
      status,
      phase: task.phase,
      finishedAt,
      elapsedMs: Math.max(0, Date.now() - task.startedAt),
      ...(message ? { message } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(evidencePath ? { evidencePath } : {}),
      ...(diagnosticPath ? { diagnosticPath } : {}),
      lastKnownUrl: this.platformStatus(task.platform).url || task.snapshot.lastKnownUrl,
    });
    task.snapshot = next;
    this.upsertRecentTask(next);
  }

  private upsertRecentTask(task: PublishTaskSnapshot): void {
    this.recentTasks = [task, ...this.recentTasks.filter((entry) => entry.taskId !== task.taskId)]
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt))
      .slice(0, RECENT_TASK_LIMIT);
  }

  private ensureCookieSubscription(platformSession: Electron.Session, platform: Platform): void {
    if (this.cookieSubscriptions.has(platform)) return;
    const subscription: CookieSubscription = {
      session: platformSession,
      snapshotTimer: null,
      listener: () => {
        if (subscription.snapshotTimer) clearTimeout(subscription.snapshotTimer);
        subscription.snapshotTimer = setTimeout(() => {
          subscription.snapshotTimer = null;
          void platformSession.flushStorageData();
          void snapshotPlatformCookies(platformSession, platform).catch(() => undefined);
        }, 2_000);
      },
    };
    platformSession.cookies.on('changed', subscription.listener);
    this.cookieSubscriptions.set(platform, subscription);
  }

  private disposeManagedView(managed: ManagedView): void {
    if (managed.recoveryTimer) clearTimeout(managed.recoveryTimer);
    managed.recoveryTimer = null;
    if (this.activePlatform === managed.platform) {
      this.window.contentView.removeChildView(managed.view);
      this.activePlatform = null;
    }
    const contents = managed.view.webContents;
    if (!contents.isDestroyed()) {
      try {
        if (contents.debugger.isAttached()) contents.debugger.detach();
      } catch {
        // The renderer may already have disconnected its debugging target.
      }
      contents.removeAllListeners();
      contents.close({ waitForBeforeUnload: false });
    }
    this.views.delete(managed.platform);
  }
}
