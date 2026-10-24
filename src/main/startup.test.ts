import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(), ipcOn: vi.fn(), handle: vi.fn(), copy: vi.fn(), dialog: vi.fn(), errorBox: vi.fn(), relaunch: vi.fn(), exit: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { on: mocks.on, relaunch: mocks.relaunch, exit: mocks.exit },
  clipboard: { writeText: mocks.copy },
  dialog: { showMessageBox: mocks.dialog, showErrorBox: mocks.errorBox },
  ipcMain: { on: mocks.ipcOn, handle: mocks.handle },
}));
import { softwareRenderingRequested, StartupSupport } from './startup.js';
import { StartupLog } from './startup-log.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalArgv = process.argv;
let directory: string;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), 'lingxi-recovery-'));
  mocks.dialog.mockResolvedValue({ response: 3 });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platform);
  process.argv = originalArgv;
  rmSync(directory, { recursive: true, force: true });
});

function fixture(htmlPath = join(directory, 'index.html')) {
  const log = new StartupLog([directory]);
  const startup = new StartupSupport(log, directory);
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: pathToFileURL(htmlPath).href }, reload: vi.fn() });
  const window = { webContents: contents, isDestroyed: () => false, show: vi.fn() };
  startup.attach(window as unknown as BrowserWindow, htmlPath);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const listener = (channel: string) => mocks.ipcOn.mock.calls.find(([name]) => name === channel)![1];
  return { log, startup, window, contents, event, listener };
}

describe('startup recovery', () => {
  it('shows a native timeout even if no renderer or preload ever starts', async () => {
    const { startup, log } = fixture();
    startup.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.report()).toContain('STARTUP_TIMEOUT');
    expect(mocks.dialog).toHaveBeenCalledOnce();
  });

  it('accepts readiness only from the workspace main frame and cancels the watchdog', async () => {
    const { startup, event, listener, log } = fixture();
    startup.start();
    listener('lingxi:startup-ready')({ ...event, senderFrame: { url: event.senderFrame.url } });
    expect(log.report()).not.toContain('renderer.ready');
    listener('lingxi:startup-ready')(event);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(log.report()).toContain('renderer.ready');
    expect(mocks.dialog).not.toHaveBeenCalled();
  });

  it('copies diagnostics from a native dialog and reloads the workspace', async () => {
    const { startup, window, contents } = fixture();
    mocks.dialog.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
    await startup.fail('PRELOAD_FAILED', 'fixture failure');
    expect(mocks.copy.mock.calls[0]![0]).toContain('PRELOAD_FAILED');
    expect(contents.reload).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('accepts encoded tilde paths for readiness and diagnostic copies without allowing other pages', async () => {
    const { startup, event, listener, log } = fixture(join(directory, 'RUNNER~1', 'index.html'));
    startup.start();
    event.senderFrame.url = event.senderFrame.url.replace(/%7e/gi, '~').replace('~', '%7E');
    listener('lingxi:startup-ready')(event);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(log.report()).toContain('"event":"renderer.ready"');
    expect(mocks.dialog).not.toHaveBeenCalled();
    const copy = mocks.handle.mock.calls.find(([name]) => name === 'lingxi:startup-copy')![1];
    expect(copy(event)).toBe(true);
    event.senderFrame.url = pathToFileURL(join(directory, 'other.html')).href;
    expect(() => copy(event)).toThrow('不允许');
  });

  it('persists Windows compatibility mode and restarts in the foreground', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.argv = ['Lingxi Workspace.exe', '--background'];
    const { startup } = fixture();
    mocks.dialog.mockResolvedValue({ response: 2 });
    await startup.fail('GPU_PROCESS_GONE', 'crashed');
    expect(readFileSync(join(directory, 'software-rendering'), 'utf8')).toBe('1');
    expect(softwareRenderingRequested(directory)).toBe(true);
    expect(mocks.relaunch).toHaveBeenCalledWith({ args: ['--disable-gpu'] });
    expect(mocks.exit).toHaveBeenCalledWith(0);
  });

  it('restarts the process after main initialization fails instead of reloading an incomplete app', async () => {
    const { startup, contents } = fixture();
    mocks.dialog.mockResolvedValue({ response: 1 });
    await startup.fail('MAIN_STARTUP_FAILED', 'project store invalid');
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it('denies diagnostic copies requested by a different window', () => {
    const { event } = fixture();
    const copy = mocks.handle.mock.calls.find(([name]) => name === 'lingxi:startup-copy')![1];
    expect(() => copy({ ...event, sender: {} })).toThrow('不允许');
    expect(mocks.copy).not.toHaveBeenCalled();
  });
});
