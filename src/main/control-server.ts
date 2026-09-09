import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { CONTROL_PROTOCOL_VERSION, MIN_SUPPORTED_CONTROL_PROTOCOL_VERSION, controlRequestSchema, type ControlRequest, type ControlResponse } from '../shared/protocol.js';
import { controlEndpoint } from './runtime-paths.js';

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 64;

export type ControlHandler = (request: ControlRequest) => Promise<unknown>;

export function errorCodeForMessage(message: string): string {
  return message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || 'CONTROL_REQUEST_FAILED';
}

export function supportsControlProtocol(value: unknown): boolean {
  const protocol = value === undefined ? MIN_SUPPORTED_CONTROL_PROTOCOL_VERSION : value;
  return typeof protocol === 'number'
    && Number.isInteger(protocol)
    && protocol >= MIN_SUPPORTED_CONTROL_PROTOCOL_VERSION
    && protocol <= CONTROL_PROTOCOL_VERSION;
}

export class ControlServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly token: string,
    private readonly handler: ControlHandler,
  ) {}

  async start(): Promise<string> {
    const endpoint = controlEndpoint();
    if (process.platform !== 'win32') await rm(endpoint, { force: true });
    this.server = createServer((socket) => this.handleSocket(socket));
    this.server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(endpoint, () => resolve());
    });
    return endpoint;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await rm(controlEndpoint(), { force: true });
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
      this.reply(socket, { id: 'unknown', ok: false, error: { code: 'REQUEST_READ_TIMEOUT', message: '请求读取超时' } }, true);
    }, READ_TIMEOUT_MS);
    socket.on('data', (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        clearTimeout(readTimeout);
        input = '';
        socket.pause();
        this.reply(socket, { id: 'unknown', ok: false, error: { code: 'REQUEST_TOO_LARGE', message: '请求体超过 5MB' } }, true);
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = '';
      handled = true;
      clearTimeout(readTimeout);
      socket.pause();
      void this.processLine(socket, line);
    });
    socket.once('close', () => clearTimeout(readTimeout));
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    let id = 'unknown';
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (typeof raw.id === 'string') id = raw.id;
      // Check compatibility before schema parsing so an old CLI gets a useful
      // upgrade error instead of a generic validation failure.
      if (typeof raw.token !== 'string' || !this.validToken(raw.token)) {
        this.reply(socket, { id, ok: false, error: { code: 'UNAUTHORIZED', message: '本地控制令牌不匹配' } });
        return;
      }
      if (!supportsControlProtocol(raw.protocolVersion)) {
        throw new Error(`CONTROL_PROTOCOL_MISMATCH: 桌面端支持协议 ${MIN_SUPPORTED_CONTROL_PROTOCOL_VERSION}-${CONTROL_PROTOCOL_VERSION}，客户端协议为 ${String(raw.protocolVersion ?? 'unknown')}，请更新 CLI 并重新加载 WorkBuddy Skill`);
      }
      const parsed = controlRequestSchema.parse(raw);
      const data = await this.handler(parsed);
      this.reply(socket, { id, ok: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = error && typeof error === 'object' && 'details' in error ? (error as { details?: unknown }).details : undefined;
      this.reply(socket, {
        id,
        ok: false,
        error: { code: errorCodeForMessage(message), message, ...(details === undefined ? {} : { details }) },
      });
    }
  }

  private validToken(candidate: string): boolean {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private reply(socket: Socket, response: ControlResponse, destroyAfterWrite = false): void {
    if (socket.destroyed) return;
    const output = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(output, 'utf8') > MAX_RESPONSE_BYTES) {
      socket.end(`${JSON.stringify({ id: response.id, ok: false, error: { code: 'RESPONSE_TOO_LARGE', message: '响应体超过 5MB' } satisfies ControlResponse['error'] })}\n`);
      socket.once('finish', () => socket.destroy());
      return;
    }
    socket.end(output);
    if (destroyAfterWrite) socket.once('finish', () => socket.destroy());
  }
}
