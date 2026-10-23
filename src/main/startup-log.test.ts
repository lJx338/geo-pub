import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupLog } from './startup-log.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

const roots: string[] = [];
function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-log-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('persistent startup diagnostics', () => {
  it('survives a fresh logger and falls back when the first directory is unusable', () => {
    const root = temporaryDirectory();
    const blocked = join(root, 'file');
    writeFileSync(blocked, 'not a directory');
    const log = new StartupLog([blocked, join(root, 'fallback')]);
    log.record('PRELOAD_FAILED', { message: 'missing preload.cjs' });
    const reopened = new StartupLog([join(root, 'fallback')]);
    expect(reopened.report()).toContain('PRELOAD_FAILED');
    expect(reopened.report()).toContain('missing preload.cjs');
  });

  it('rotates a full log and retains the new failure', () => {
    const root = temporaryDirectory();
    const log = new StartupLog([root]);
    writeFileSync(log.path!, 'x'.repeat(1024 * 1024));
    log.record('RENDERER_PROCESS_GONE', { reason: 'crashed' });
    expect(readFileSync(`${log.path}.1`, 'utf8').length).toBe(1024 * 1024);
    expect(log.report()).toContain('RENDERER_PROCESS_GONE');
    expect(readFileSync(log.path!, 'utf8').length).toBeLessThan(1000);
  });

  it('keeps a bounded copyable report if disk writes fail', () => {
    const root = temporaryDirectory();
    const log = new StartupLog([root]);
    rmSync(root, { recursive: true });
    for (let i = 0; i < 100; i++) log.record(`failure-${i}`, 'x'.repeat(20_000));
    expect(log.report()).toContain('failure-99');
    expect(log.report().length).toBeLessThan(49_000);
    expect(() => log.record('circular', log)).not.toThrow();
  });

  it('exports the latest in-memory failure when an old log is readable but disk writes fail', () => {
    const root = temporaryDirectory();
    const log = new StartupLog([root], 'materials.log');
    log.record('old-event');
    vi.mocked(appendFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
    log.record('latest-failure', { code: 'ENOSPC' });
    expect(readFileSync(log.path!, 'utf8')).not.toContain('latest-failure');
    expect(log.report('素材诊断')).toContain('latest-failure');
  });
});
