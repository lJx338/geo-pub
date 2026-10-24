import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_REPORT_CHARS = 48_000;

/** Small synchronous writes keep the last startup failure even if Electron exits. */
export class StartupLog {
  path: string | null = null;
  private readonly recent: string[] = [];
  private diskWriteFailed = false;

  constructor(directories: string[], fileName = 'startup.log') {
    for (const directory of directories) {
      try {
        mkdirSync(directory, { recursive: true });
        const candidate = join(directory, fileName);
        appendFileSync(candidate, '', { mode: 0o600 });
        this.path = candidate;
        break;
      } catch {
        // MSIX can redirect AppData. Try the OS temporary directory next.
      }
    }
  }

  record(event: string, details: unknown = {}): void {
    let value: string;
    try { value = JSON.stringify(details) ?? 'null'; } catch { value = '"[unserializable]"'; }
    const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, details: value.length > 12_000 ? value.slice(0, 12_000) : JSON.parse(value) });
    this.recent.push(line);
    if (this.recent.length > 80) this.recent.shift();
    if (!this.path) return;
    try {
      if (statSync(this.path).size >= MAX_LOG_BYTES) renameSync(this.path, `${this.path}.1`);
      appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
    } catch {
      this.diskWriteFailed = true;
      // Logging must not prevent startup; the copy button can use memory.
    }
  }

  report(title = 'Lingxi Workspace 启动诊断'): string {
    let tail = this.recent.join('\n');
    if (this.path && !this.diskWriteFailed) {
      try { tail = readFileSync(this.path, 'utf8').slice(-MAX_REPORT_CHARS); } catch { /* use memory */ }
    }
    return `${title}\n日志：${this.path ?? '无法写入磁盘，使用内存记录'}\n${tail.slice(-MAX_REPORT_CHARS)}`;
  }
}
