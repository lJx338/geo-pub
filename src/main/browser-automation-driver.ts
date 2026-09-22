import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import type { Platform } from '../shared/protocol.js';
import { evidenceDirectory } from './runtime-paths.js';

export type BrowserActionStatus = 'success' | 'failed' | 'skipped';

export interface BrowserActionResult {
  action: string;
  status: BrowserActionStatus;
  blocking: boolean;
  retryable: boolean;
  attempts: number;
  elapsedMs: number;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  evidencePath?: string;
  errorCode?: string;
}

interface PageFingerprint {
  url: string;
  title: string;
  text: string;
}

export interface BrowserAutomationViewport {
  width: number;
  height: number;
}

export interface BrowserAutomationDriverOptions {
  viewport?: BrowserAutomationViewport;
}

const activeDrivers = new WeakMap<WebContents, BrowserAutomationDriver>();

export function activeBrowserAutomationDriver(webContents: WebContents): BrowserAutomationDriver | null {
  return activeDrivers.get(webContents) ?? null;
}

export async function cdpClick(webContents: WebContents, point: { x: number; y: number }): Promise<void> {
  const driver = activeBrowserAutomationDriver(webContents);
  if (driver) return await driver.click(point);
  const transient = new BrowserAutomationDriver(webContents, 'zhihu');
  await transient.run(async () => await transient.click(point));
}

export async function cdpKey(
  webContents: WebContents,
  key: string,
  code: string,
  windowsVirtualKeyCode: number,
  modifiers = 0,
): Promise<void> {
  const driver = activeBrowserAutomationDriver(webContents);
  if (driver) return await driver.key(key, code, windowsVirtualKeyCode, modifiers);
  const transient = new BrowserAutomationDriver(webContents, 'zhihu');
  await transient.run(async () => await transient.key(key, code, windowsVirtualKeyCode, modifiers));
}

export async function cdpInsertText(webContents: WebContents, text: string): Promise<void> {
  const driver = activeBrowserAutomationDriver(webContents);
  if (driver) return await driver.insertText(text);
  const transient = new BrowserAutomationDriver(webContents, 'penguin');
  await transient.run(async () => await transient.insertText(text));
}

export async function runWithBrowserAutomationDriver<T>(
  driver: BrowserAutomationDriver,
  operation: () => Promise<T>,
): Promise<T> {
  return await driver.run(operation);
}

export class BrowserAutomationDriver {
  private attachedHere = false;
  private readonly actionResults: BrowserActionResult[] = [];

  constructor(
    readonly webContents: WebContents,
    readonly platform: Platform,
    private readonly options: BrowserAutomationDriverOptions = {},
  ) {}

  results(): BrowserActionResult[] {
    return [...this.actionResults];
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const debuggerApi = this.webContents.debugger;
    this.attachedHere = !debuggerApi.isAttached();
    if (this.attachedHere) debuggerApi.attach('1.3');
    activeDrivers.set(this.webContents, this);
    try {
      const viewport = this.automationViewport();
      await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      });
      return await operation();
    } finally {
      activeDrivers.delete(this.webContents);
      if (this.attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  async action<T>(
    action: string,
    operation: () => Promise<T>,
    options: { blocking?: boolean; retryable?: boolean; captureOnFailure?: boolean } = {},
  ): Promise<T> {
    const startedAt = Date.now();
    const beforeFingerprint = await this.fingerprint().catch(() => undefined);
    try {
      const value = await operation();
      this.actionResults.push({
        action,
        status: 'success',
        blocking: options.blocking ?? true,
        retryable: options.retryable ?? false,
        attempts: 1,
        elapsedMs: Date.now() - startedAt,
        beforeFingerprint,
        afterFingerprint: await this.fingerprint().catch(() => undefined),
      });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.actionResults.push({
        action,
        status: 'failed',
        blocking: options.blocking ?? true,
        retryable: options.retryable ?? false,
        attempts: 1,
        elapsedMs: Date.now() - startedAt,
        beforeFingerprint,
        afterFingerprint: await this.fingerprint().catch(() => undefined),
        ...(options.captureOnFailure === false ? {} : { evidencePath: await this.capture(`${action}-failed`).catch(() => undefined) }),
        errorCode: errorCode(message),
      });
      if (error instanceof Error) {
        Object.assign(error, { automationActions: this.results() });
      }
      throw error;
    }
  }

  async click(point: { x: number; y: number }): Promise<void> {
    const debuggerApi = this.webContents.debugger;
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  async key(key: string, code: string, windowsVirtualKeyCode: number, modifiers = 0): Promise<void> {
    const debuggerApi = this.webContents.debugger;
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
  }

  async insertText(text: string): Promise<void> {
    await this.webContents.debugger.sendCommand('Input.insertText', { text });
  }

  async setFileInput(selector: string, filePath: string): Promise<void> {
    const debuggerApi = this.webContents.debugger;
    const documentNode = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } };
    const query = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector,
    }) as { nodeId: number };
    if (!query.nodeId) throw new Error('ACTION_TARGET_NOT_READY: 未找到文件上传控件');
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: query.nodeId });
  }

  async waitForStable(
    script: string,
    timeoutMs = 15_000,
    stableSamples = 3,
    pollMs = 150,
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let previous = '';
    let streak = 0;
    while (Date.now() < deadline) {
      const value = await this.webContents.executeJavaScript(script);
      const fingerprint = JSON.stringify(value);
      if (value && fingerprint === previous) streak += 1;
      else streak = value ? 1 : 0;
      if (streak >= stableSamples) return value;
      previous = fingerprint;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error('ACTION_TARGET_NOT_READY: 目标状态未在超时内稳定');
  }

  async waitForMutationCondition(predicate: string, timeoutMs = 15_000): Promise<void> {
    const observed = await this.webContents.executeJavaScript(`new Promise((resolve) => {
      const evaluate = () => {
        try { return Boolean((${predicate})); } catch { return false; }
      };
      if (evaluate()) return resolve(true);
      const observer = new MutationObserver(() => {
        if (!evaluate()) return;
        observer.disconnect();
        resolve(true);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      setTimeout(() => { observer.disconnect(); resolve(false); }, ${timeoutMs});
    })`);
    if (!observed) throw new Error('ACTION_TARGET_NOT_READY: 等待页面变更超时');
  }

  private async fingerprint(): Promise<string> {
    const value = await this.webContents.executeJavaScript(`(() => ({
      url: location.href,
      title: document.title,
      text: String(document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 4000),
    }))()` ) as PageFingerprint;
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private automationViewport(): BrowserAutomationViewport {
    const configured = this.options.viewport;
    if (configured) {
      return { width: Math.max(1, Math.floor(configured.width)), height: Math.max(1, Math.floor(configured.height)) };
    }
    const owner = BrowserWindow.fromWebContents(this.webContents);
    const [width = 1440, height = 1000] = owner?.getContentSize() ?? [];
    return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) };
  }

  private async capture(stage: string): Promise<string> {
    const directory = join(evidenceDirectory(), new Date().toISOString().slice(0, 10));
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-${this.platform}-${stage}.png`);
    const image = await this.webContents.capturePage();
    await writeFile(path, image.toPNG());
    return path;
  }
}

function errorCode(message: string): string {
  return message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || 'ACTION_EFFECT_NOT_OBSERVED';
}
