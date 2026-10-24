import type { Writable } from 'node:stream';

const guardedStreams = new WeakSet<Writable>();
let diagnosticSink: ((message: string) => void) | undefined;

export function setDiagnosticSink(sink: (message: string) => void): void {
  diagnosticSink = sink;
}

function guardStream(stream: Writable | undefined): void {
  if (!stream || guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  // Desktop applications can outlive the shell/PTY that started them. A
  // diagnostic write to that detached stream may emit EIO/EPIPE; logging must
  // never terminate the Electron main process.
  stream.on('error', () => undefined);
}

export function guardProcessOutputStreams(): void {
  guardStream(process.stdout);
  guardStream(process.stderr);
}

export function diagnosticError(message: string, persist = true): void {
  try { if (persist) diagnosticSink?.(message); } catch { /* diagnostics are best effort */ }
  guardProcessOutputStreams();
  const stream = process.stderr;
  if (!stream || stream.destroyed || stream.writableEnded) return;
  try {
    stream.write(`${message}\n`);
  } catch {
    // Diagnostics are best effort. Runtime behavior must not depend on a TTY.
  }
}
