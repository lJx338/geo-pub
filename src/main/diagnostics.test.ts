import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { diagnosticError, guardProcessOutputStreams } from './diagnostics.js';

describe('main process diagnostics', () => {
  it('does not throw when the launching terminal is unavailable', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw Object.assign(new Error('write EIO'), { code: 'EIO' }); });
    expect(() => diagnosticError('renderer warning')).not.toThrow();
    write.mockRestore();
  });

  it('installs output guards idempotently', () => {
    const before = process.stderr.listenerCount('error');
    guardProcessOutputStreams();
    guardProcessOutputStreams();
    expect(process.stderr.listenerCount('error')).toBeGreaterThanOrEqual(before);
  });

  it('a detached writable error can be handled without becoming uncaught', async () => {
    const stream = new Writable({ write: (_chunk, _encoding, callback) => callback(Object.assign(new Error('write EIO'), { code: 'EIO' })) });
    const handled = new Promise<void>((resolve) => stream.once('error', () => resolve()));
    stream.write('diagnostic');
    await expect(handled).resolves.toBeUndefined();
  });
});
