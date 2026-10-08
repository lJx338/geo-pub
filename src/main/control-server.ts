import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { controlRequestSchema, type ControlRequest, type ControlResponse } from '../shared/protocol.js';
import { controlEndpoint, setActiveControlEndpoint } from './runtime-paths.js';
import { AttentionRequiredError } from './attention-required.js';

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

export type ControlHandler = (request: ControlRequest) => Promise<unknown>;

export function errorCodeForMessage(message: string): string {
  return message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || 'CONTROL_REQUEST_FAILED';
}

export class ControlServer {
  private server: Server | null = null;
  private endpoint: string | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly token: string, private readonly handler: ControlHandler) {}

  async start(): Promise<string> {
    const endpoint = controlEndpoint();
    const tcp = endpoint === 'tcp://127.0.0.1:0';
    if (!tcp && process.platform !== 'win32') await rm(endpoint, { force: true });
    this.server = createServer((socket) => this.handleSocket(socket));
    this.server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      if (tcp) this.server?.listen(0, '127.0.0.1', () => resolve());
      else this.server?.listen(endpoint, () => resolve());
    });
    this.endpoint = tcp ? `tcp://127.0.0.1:${(this.server.address() as AddressInfo).port}` : endpoint;
    if (tcp) setActiveControlEndpoint(this.endpoint);
    return this.endpoint;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.endpoint && !this.endpoint.startsWith('tcp://') && process.platform !== 'win32') await rm(this.endpoint, { force: true });
    if (this.endpoint?.startsWith('tcp://')) setActiveControlEndpoint(undefined);
    this.endpoint = null;
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(300_000, () => socket.destroy());
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;
    socket.on('data', (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        this.reply(socket, { id: 'unknown', ok: false, error: { code: 'REQUEST_TOO_LARGE', message: '请求体超过 5MB' } });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      const line = input.slice(0, newline);
      input = '';
      void this.processLine(socket, line);
    });
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    let id = 'unknown';
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (typeof raw.id === 'string') id = raw.id;
      const parsed = controlRequestSchema.parse(raw);
      if (!this.validToken(parsed.token)) {
        this.reply(socket, { id, ok: false, error: { code: 'UNAUTHORIZED', message: '本地控制令牌不匹配' } });
        return;
      }
      const data = await this.handler(parsed);
      this.reply(socket, { id, ok: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attention = error instanceof AttentionRequiredError ? error : null;
      const details = attention?.details || (error && typeof error === 'object' && 'details' in error
        ? (error as { details?: unknown }).details
        : undefined);
      this.reply(socket, {
        id,
        ok: false,
        error: { code: attention?.code || errorCodeForMessage(message), message, details },
      });
    }
  }

  private validToken(candidate: string): boolean {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private reply(socket: Socket, response: ControlResponse): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }
}
