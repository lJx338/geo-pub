import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import {
  BROWSER_WORKER_PROTOCOL_VERSION,
  type BrowserWorkerRequest,
  type BrowserWorkerResponse,
} from './browser-worker-protocol.js';

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 64;

export type BrowserWorkerHandler = (request: BrowserWorkerRequest) => Promise<unknown>;

export class BrowserWorkerServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly appVersion: string,
    private readonly handler: BrowserWorkerHandler,
  ) {}

  async start(): Promise<void> {
    if (process.platform !== 'win32') await rm(this.endpoint, { force: true });
    this.server = createServer((socket) => this.handleSocket(socket));
    this.server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.endpoint, () => resolve());
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await rm(this.endpoint, { force: true });
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;
    const readTimeout = setTimeout(() => {
      handled = true;
      input = '';
      socket.pause();
      this.reply(socket, { id: 'unknown', ok: false, error: { code: 'WORKER_REQUEST_READ_TIMEOUT', message: 'Worker 请求读取超时' } }, true);
    }, READ_TIMEOUT_MS);
    socket.on('data', (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        clearTimeout(readTimeout);
        input = '';
        socket.pause();
        this.reply(socket, { id: 'unknown', ok: false, error: { code: 'WORKER_REQUEST_TOO_LARGE', message: 'Worker 请求体超过 5MB' } }, true);
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = '';
      handled = true;
      clearTimeout(readTimeout);
      socket.pause();
      void this.process(socket, line);
    });
    socket.once('close', () => clearTimeout(readTimeout));
  }

  private async process(socket: Socket, line: string): Promise<void> {
    let id = 'unknown';
    try {
      const request = JSON.parse(line) as BrowserWorkerRequest;
      id = typeof request.id === 'string' ? request.id : id;
      if (!this.validToken(request.token)) throw new Error('WORKER_UNAUTHORIZED: Browser Worker 令牌不匹配');
      if (request.protocolVersion !== BROWSER_WORKER_PROTOCOL_VERSION) {
        throw new Error(`WORKER_PROTOCOL_MISMATCH: expected=${BROWSER_WORKER_PROTOCOL_VERSION}, received=${request.protocolVersion}`);
      }
      if (request.appVersion !== this.appVersion) {
        throw new Error(`WORKER_VERSION_MISMATCH: expected=${this.appVersion}, received=${request.appVersion}`);
      }
      if (!request.action) throw new Error('WORKER_INVALID_REQUEST: Browser Worker 缺少 action');
      this.reply(socket, { id, ok: true, data: await this.handler(request) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || 'WORKER_REQUEST_FAILED';
      this.reply(socket, { id, ok: false, error: { code, message } });
    }
  }

  private validToken(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private reply(socket: Socket, response: BrowserWorkerResponse, destroyAfterWrite = false): void {
    if (socket.destroyed) return;
    const output = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(output, 'utf8') > MAX_RESPONSE_BYTES) {
      socket.end(`${JSON.stringify({ id: response.id, ok: false, error: { code: 'WORKER_RESPONSE_TOO_LARGE', message: 'Worker 响应体超过 5MB' } })}\n`);
      socket.once('finish', () => socket.destroy());
      return;
    }
    socket.end(output);
    if (destroyAfterWrite) socket.once('finish', () => socket.destroy());
  }
}
