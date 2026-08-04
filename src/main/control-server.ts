import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { controlRequestSchema, type ControlRequest, type ControlResponse } from '../shared/protocol.js';
import { controlEndpoint } from './runtime-paths.js';

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

export type ControlHandler = (request: ControlRequest) => Promise<unknown>;

export function errorCodeForMessage(message: string): string {
  return message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || 'CONTROL_REQUEST_FAILED';
}

export class ControlServer {
  private server: Server | null = null;

  constructor(private readonly token: string, private readonly handler: ControlHandler) {}

  async start(): Promise<string> {
    const endpoint = controlEndpoint();
    if (process.platform !== 'win32') await rm(endpoint, { force: true });
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(endpoint, () => resolve());
    });
    return endpoint;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await rm(controlEndpoint(), { force: true });
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        this.reply(socket, { id: 'unknown', ok: false, error: { code: 'REQUEST_TOO_LARGE', message: '请求体超过 5MB' } });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
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
      this.reply(socket, {
        id,
        ok: false,
        error: { code: errorCodeForMessage(message), message },
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
