import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { persistSandboxFile } from './sandbox-imports.js';

const MAX_BODY = 96 * 1024 * 1024;
const MAX_OUTPUT = 10 * 1024 * 1024;
const requestSchema = z.object({
  args: z.array(z.string().max(8192).refine(value => !value.includes('\0'))).max(128),
  stdin: z.string().max(5 * 1024 * 1024).default(''),
  files: z.array(z.object({
    path: z.string().min(1).max(8192),
    base64: z.string().max(MAX_BODY),
    json: z.boolean().default(false),
  })).max(64).default([]),
});
export interface CliResult { stdout: string; stderr: string; exitCode: number }
type Execute = (args: string[], stdin: string, signal: AbortSignal) => Promise<CliResult>;

/** Imports bytes supplied by the external client. Never reads a client-selected server path. */
export async function prepareBridgeInput(input: unknown, dataDir: string): Promise<{ args: string[]; stdin: string }> {
  const request = requestSchema.parse(input);
  const paths = new Map<string, string>();
  const decoded = request.files.map(file => {
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.toString('base64') !== file.base64) throw new Error('Invalid file encoding');
    if (file.json && bytes.length > 5 * 1024 * 1024) throw new Error('JSON input exceeds 5 MB');
    if (paths.has(file.path)) throw new Error('Duplicate input path');
    paths.set(file.path, '');
    return { ...file, bytes };
  });
  const save = (bytes: Buffer, original: string) => persistSandboxFile(dataDir, bytes, original);
  for (const file of decoded.filter(file => !file.json)) paths.set(file.path, await save(file.bytes, file.path));
  function remap(value: unknown): unknown {
    if (typeof value === 'string') return paths.get(value) || value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    return value;
  }
  for (const file of decoded.filter(file => file.json)) {
    const bytes = Buffer.from(JSON.stringify(remap(JSON.parse(file.bytes.toString('utf8')))));
    paths.set(file.path, await save(bytes, file.path));
  }
  return {
    args: request.args.map(arg => paths.get(arg) || arg),
    stdin: request.stdin.trim() ? JSON.stringify(remap(JSON.parse(request.stdin))) : '',
  };
}

function executeCli(helper: string, dataDir: string, endpoint: string): Execute {
  return (args, stdin, signal) => new Promise((resolve, reject) => {
    const child = spawn(helper, args, {
      shell: false, signal, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GEO_PUBLISHER_MAS: '1', GEO_PUBLISHER_USER_DATA_DIR: dataDir, GEO_PUBLISHER_CONTROL_ENDPOINT: endpoint },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let total = 0;
    function collect(target: Buffer[], chunk: Buffer): void {
      total += chunk.length;
      if (total > MAX_OUTPUT) { child.kill(); reject(new Error('CLI output exceeds 10 MB')); }
      else target.push(chunk);
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', reject);
    child.on('close', code => resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1 }));
    child.stdin.end(stdin);
  });
}

export class MasCliBridge {
  private server: Server | undefined;
  private readonly active = new Set<AbortController>();
  private url = '';
  private readonly execute: Execute;
  constructor(private readonly options: { token: string; dataDir: string; helper: string; endpoint: string; execute?: Execute }) {
    this.execute = options.execute ?? executeCli(options.helper, options.dataDir, options.endpoint);
  }
  async start(): Promise<string> {
    const server = this.server = createServer(async (request, response) => {
      const respond = (status: number, body: unknown) => {
        if (!response.destroyed) response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
      };
      const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const expected = Buffer.from(this.options.token), candidate = Buffer.from(token);
      if (request.headers.origin || request.headers.host !== this.url.slice('http://'.length)
        || expected.length !== candidate.length || !timingSafeEqual(expected, candidate)) {
        request.resume(); respond(403, { error: 'Unauthorized local client' }); return;
      }
      if (request.method === 'GET' && request.url === '/health') { respond(200, { ok: true }); return; }
      if (request.method !== 'POST' || request.url !== '/v1/cli' || request.headers['content-type'] !== 'application/json') {
        request.resume(); respond(400, { error: 'Invalid bridge request' }); return;
      }
      if (this.active.size >= 4) { request.resume(); respond(429, { error: 'CLI is busy; wait for running commands' }); return; }
      const controller = new AbortController();
      this.active.add(controller);
      const timer = setTimeout(() => { controller.abort(); response.destroy(); }, 300_000);
      response.once('close', () => controller.abort());
      try {
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          length += chunk.length;
          if (length > MAX_BODY) { respond(413, { error: 'Input exceeds 96 MB' }); request.destroy(); return; }
          chunks.push(chunk);
        }
        const prepared = await prepareBridgeInput(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.options.dataDir);
        controller.signal.throwIfAborted();
        const result = await this.execute(prepared.args, prepared.stdin, controller.signal);
        respond(200, result);
      } catch (error) {
        respond(400, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timer);
        this.active.delete(controller);
      }
    });
    server.maxConnections = 16;
    server.requestTimeout = 300_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const path = join(this.options.dataDir, 'mas-cli-bridge.json');
    await writeFile(`${path}.tmp`, JSON.stringify({ url: this.url, pid: process.pid }), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    return this.url;
  }
  async stop(): Promise<void> {
    for (const controller of this.active) controller.abort();
    const server = this.server;
    this.server = undefined;
    if (server) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    const path = join(this.options.dataDir, 'mas-cli-bridge.json');
    try { if (JSON.parse(await readFile(path, 'utf8')).url === this.url) await rm(path); } catch { /* Already removed. */ }
  }
}
