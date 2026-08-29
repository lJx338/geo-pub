import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { app } from 'electron';
import type { DesktopStatus, Platform, PlatformStatus } from '../shared/protocol.js';
import {
  BROWSER_WORKER_ENDPOINT_ENV,
  BROWSER_WORKER_APP_VERSION_ENV,
  BROWSER_WORKER_PROTOCOL_ENV,
  BROWSER_WORKER_PROTOCOL_VERSION,
  BROWSER_WORKER_TOKEN_ENV,
  type BrowserWorkerAction,
  type BrowserWorkerHealth,
  type BrowserWorkerRequest,
  type BrowserWorkerResponse,
} from './browser-worker-protocol.js';
import { workerEndpoint } from './runtime-paths.js';

const START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 4 * 60_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

type ArticlePayload = { platform: Platform; title: string; html: string; coverPath: string; tags: string[] };

export class BrowserWorkerClient {
  private child: ChildProcess | null = null;
  private startup: Promise<void> | null = null;
  private endpoint: string | null = null;
  private token: string | null = null;
  private generation = 0;
  private health: BrowserWorkerHealth = {
    state: 'unavailable', pid: null, protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, lastError: null,
  };
  private latestStatus: DesktopStatus | null = null;

  constructor(private readonly appVersion: string) {}

  async start(): Promise<void> {
    if (this.health.state === 'ready') return;
    if (this.startup) return await this.startup;
    const startup = this.startInternal();
    this.startup = startup;
    try {
      await startup;
    } finally {
      if (this.startup === startup) this.startup = null;
    }
  }

  private async startInternal(): Promise<void> {
    const generation = ++this.generation;
    const endpoint = workerEndpoint();
    const token = randomBytes(32).toString('hex');
    this.endpoint = endpoint;
    this.token = token;
    this.health = { state: 'starting', pid: null, protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, lastError: null };
    const args = process.defaultApp ? [app.getAppPath(), '--browser-worker'] : ['--browser-worker'];
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        [BROWSER_WORKER_ENDPOINT_ENV]: endpoint,
        [BROWSER_WORKER_TOKEN_ENV]: token,
        [BROWSER_WORKER_PROTOCOL_ENV]: String(BROWSER_WORKER_PROTOCOL_VERSION),
        [BROWSER_WORKER_APP_VERSION_ENV]: this.appVersion,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    this.child = child;
    this.health.pid = child.pid ?? null;
    const unavailable = (message: string) => {
      if (this.generation === generation && this.child === child) this.markUnavailable(message);
    };
    child.once('error', (error) => unavailable(error.message));
    child.once('exit', (code, signal) => unavailable(`Worker 已退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`));

    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError = 'Worker 尚未监听本地端点';
    while (Date.now() < deadline && this.generation === generation) {
      try {
        const status = await this.request<DesktopStatus>('status', undefined, 1_000);
        this.latestStatus = status;
        this.health.state = 'ready';
        this.health.lastError = null;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    if (this.generation === generation) {
      this.markUnavailable(lastError);
      child.kill();
      await this.removeEndpoint(endpoint);
    }
    throw new Error(`WORKER_START_TIMEOUT: ${lastError}`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    const endpoint = this.endpoint;
    ++this.generation;
    if (child) {
      try {
        await this.request('shutdown', undefined, 5_000);
      } catch {
        child.kill();
      }
      if (!child.killed) child.kill();
    }
    this.child = null;
    this.endpoint = null;
    this.token = null;
    this.latestStatus = null;
    this.markUnavailable(null);
    if (endpoint) await this.removeEndpoint(endpoint);
  }

  isBusy(): boolean {
    return this.latestStatus?.busy ?? false;
  }

  workerHealth(): BrowserWorkerHealth {
    return { ...this.health };
  }

  async status(): Promise<DesktopStatus> {
    await this.ensureStarted();
    const status = await this.request<DesktopStatus>('status');
    this.latestStatus = status;
    return status;
  }

  async open(platform: Platform): Promise<PlatformStatus> {
    await this.ensureStarted();
    return await this.requestTask('platform.open', { platform }, 135_000);
  }

  async inspect(platform: Platform): Promise<unknown> {
    await this.ensureStarted();
    return await this.requestTask('platform.inspect', { platform }, 135_000);
  }

  async fillDraft(payload: ArticlePayload): Promise<unknown> {
    await this.ensureStarted();
    return await this.requestTask('draft.fill', payload, 210_000);
  }

  async publishDraft(payload: ArticlePayload): Promise<unknown> {
    await this.ensureStarted();
    return await this.requestTask('draft.publish', payload, 270_000);
  }

  private async ensureStarted(): Promise<void> {
    if (this.health.state !== 'ready') await this.start();
  }

  private async requestTask<T>(action: BrowserWorkerAction, payload: BrowserWorkerRequest['payload'], timeoutMs: number): Promise<T> {
    try {
      return await this.request<T>(action, payload, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('WORKER_REQUEST_TIMEOUT:')) throw error;
      try {
        this.latestStatus = await this.request<DesktopStatus>('status', undefined, 1_000);
      } catch {
        // A wedged renderer may not answer status; treat a publish as ambiguous below.
      }
      const phase = this.latestStatus?.activeTask?.phase;
      const ambiguousPublish = action === 'draft.publish' && (!phase || phase === 'dispatching' || phase === 'dispatched' || phase === 'reconciling');
      await this.restartAfterTimeout();
      throw this.recoveryError(
        ambiguousPublish ? 'RESULT_UNCERTAIN' : 'BACKGROUND_LIFECYCLE_LOST',
        ambiguousPublish
          ? '发布任务超时且结果可能已提交，已重启浏览器进程；禁止自动重发，请先对账。'
          : '浏览器任务超时，已重启浏览器进程；该任务可以人工确认后重试。',
        !ambiguousPublish,
        phase,
      );
    }
  }

  private async restartAfterTimeout(): Promise<void> {
    await this.stop().catch(() => undefined);
    await this.start().catch((error) => this.markUnavailable(error instanceof Error ? error.message : String(error)));
  }

  private recoveryError(code: string, message: string, safeToRetry: boolean, phase: string | undefined): Error & { details: unknown } {
    const error = new Error(`${code}: ${message}`) as Error & { details: unknown };
    error.details = { safeToRetry, phase: phase ?? 'unknown', workerRestarted: this.health.state === 'ready' };
    return error;
  }

  private async request<T>(action: BrowserWorkerAction, payload?: BrowserWorkerRequest['payload'], timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const endpoint = this.endpoint;
    const token = this.token;
    if (!endpoint || !token) throw new Error('WORKER_UNAVAILABLE: Browser Worker 尚未启动');
    const request: BrowserWorkerRequest = {
      id: randomUUID(), token, protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, appVersion: this.appVersion, action, payload,
    };
    return await new Promise<T>((resolve, reject) => {
      const socket = createConnection(endpoint);
      let input = '';
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeAllListeners('connect');
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
      };
      const settle = (callback: () => void, destroy = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (destroy && !socket.destroyed) socket.destroy();
        callback();
      };
      const timeout = setTimeout(() => settle(() => reject(new Error(`WORKER_REQUEST_TIMEOUT: ${action} 超时`)), true), timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk: string) => {
        input += chunk;
        if (Buffer.byteLength(input, 'utf8') > MAX_RESPONSE_BYTES) {
          settle(() => reject(new Error('WORKER_RESPONSE_TOO_LARGE: Worker 响应体超过 5MB')), true);
        }
      });
      socket.once('error', (error) => settle(() => reject(new Error(`WORKER_UNAVAILABLE: ${error.message}`))));
      socket.once('close', () => settle(() => {
        try {
          const response = JSON.parse(input.trim()) as BrowserWorkerResponse;
          if (!response.ok) throw new Error(`${response.error?.code || 'WORKER_REQUEST_FAILED'}: ${response.error?.message || action}`);
          resolve(response.data as T);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }));
    });
  }

  private async removeEndpoint(endpoint: string): Promise<void> {
    if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined);
  }

  private markUnavailable(error: string | null): void {
    this.health = {
      state: 'unavailable', pid: null, protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, lastError: error,
    };
  }
}
