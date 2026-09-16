import { describe, expect, it, vi } from 'vitest';
import { concealWorkerWindow, revealWorkerWindow, type WorkerWindowVisibilityTarget } from './worker-window-visibility.js';

function mockWindow(minimized = false): WorkerWindowVisibilityTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: vi.fn(() => calls.push('restore')),
    setSkipTaskbar: vi.fn((skip) => calls.push(`taskbar:${skip}`)),
    show: vi.fn(() => calls.push('show')),
    showInactive: vi.fn(() => calls.push('showInactive')),
    moveTop: vi.fn(() => calls.push('moveTop')),
    focus: vi.fn(() => calls.push('focus')),
    setAlwaysOnTop: vi.fn((flag) => calls.push(`alwaysOnTop:${flag}`)),
    hide: vi.fn(() => calls.push('hide')),
  };
}

describe('worker window visibility', () => {
  it('restores a minimized Windows worker and makes it discoverable', () => {
    const window = mockWindow(true);
    revealWorkerWindow(window, true);
    expect(window.calls).toEqual([
      'taskbar:false',
      'restore',
      'alwaysOnTop:true',
      'show',
      'moveTop',
      'focus',
      'alwaysOnTop:false',
    ]);
  });

  it('restores an execution surface without taking focus from the user', () => {
    const window = mockWindow(true);
    revealWorkerWindow(window, false, false);
    expect(window.calls).toEqual(['restore', 'showInactive']);
  });

  it('foregrounds an execution surface without changing its taskbar mode', () => {
    const window = mockWindow();
    revealWorkerWindow(window, false, true);
    expect(window.calls).toEqual(['show', 'moveTop', 'focus']);
  });

  it('hides the worker from both the desktop and taskbar', () => {
    const window = mockWindow();
    concealWorkerWindow(window, true);
    expect(window.calls).toEqual(['hide', 'taskbar:true']);
  });
});
