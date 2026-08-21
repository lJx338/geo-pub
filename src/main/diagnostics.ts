import type { Writable } from 'node:stream';

const guardedStreams = new WeakSet<Writable>();

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

export function diagnosticError(message: string): void {
  guardProcessOutputStreams();
  const stream = process.stderr;
  if (!stream || stream.destroyed || stream.writableEnded) return;
  try {
    stream.write(`${message}\n`);
  } catch {
    // Diagnostics are best effort. Runtime behavior must not depend on a TTY.
  }
}
