import { describe, expect, it } from 'vitest';
import { captureEvidenceBestEffort, executionSurfaceIssue, formatWarningsFromResult, nextExecutionSurfaceStableSamples, pickEvictionCandidate, platformRuntimeState, shouldUseWindowsEditorForeground } from './platform-sessions.js';

describe('platform view eviction', () => {
  it('evicts the least recently used inactive platform', () => {
    expect(pickEvictionCandidate([
      { platform: 'baijia', lastUsedAt: 10 },
      { platform: 'toutiao', lastUsedAt: 30 },
      { platform: 'zhihu', lastUsedAt: 20 },
    ], 'toutiao', 'penguin')).toBe('baijia');
  });

  it('evicts the active platform when it is the only replaceable view', () => {
    expect(pickEvictionCandidate([
      { platform: 'baijia', lastUsedAt: 10 },
      { platform: 'toutiao', lastUsedAt: 20 },
    ], 'baijia', 'toutiao')).toBe('baijia');
  });
});

describe('platform runtime status', () => {
  it('does not confuse view residency with login state', () => {
    expect(platformRuntimeState(false, false)).toBe('not_loaded');
    expect(platformRuntimeState(true, false)).toBe('resident');
    expect(platformRuntimeState(true, true)).toBe('active');
  });
});

describe('Windows editor foreground policy', () => {
  it('raises every Windows publishing surface for fill and publish', () => {
    expect(shouldUseWindowsEditorForeground('zhihu', 'fill', 'win32')).toBe(true);
    expect(shouldUseWindowsEditorForeground('sohu', 'fill', 'win32')).toBe(true);
    expect(shouldUseWindowsEditorForeground('netease', 'publish', 'win32')).toBe(true);
    expect(shouldUseWindowsEditorForeground('toutiao', 'fill', 'win32')).toBe(true);
    expect(shouldUseWindowsEditorForeground('zhihu', 'open', 'win32')).toBe(false);
    expect(shouldUseWindowsEditorForeground('zhihu', 'fill', 'darwin')).toBe(false);
  });
});

describe('execution surface validation', () => {
  const minimum = { width: 800, height: 500 };

  it('rejects a hidden or minimized worker before adapter actions begin', () => {
    expect(executionSurfaceIssue({ windowVisible: false, windowMinimized: false, contentWidth: 1440, contentHeight: 900, viewportWidth: 1440, viewportHeight: 900, pageVisible: true }, minimum)).toBe('window_hidden');
    expect(executionSurfaceIssue({ windowVisible: true, windowMinimized: true, contentWidth: 0, contentHeight: 0, viewportWidth: 1, viewportHeight: 1, pageVisible: false }, minimum)).toBe('window_minimized');
  });

  it('requires a visible page with a usable render surface', () => {
    expect(executionSurfaceIssue({ windowVisible: true, windowMinimized: false, contentWidth: 1440, contentHeight: 900, viewportWidth: 1440, viewportHeight: 852, pageVisible: true }, minimum)).toBeNull();
    expect(executionSurfaceIssue({ windowVisible: true, windowMinimized: false, contentWidth: 1440, contentHeight: 900, viewportWidth: 1, viewportHeight: 1, pageVisible: true }, minimum)).toBe('viewport_too_small');
  });

  it('accepts consecutive usable samples without requiring pixel-identical dimensions', () => {
    const states = [
      { windowVisible: true, windowMinimized: false, contentWidth: 1440, contentHeight: 900, viewportWidth: 1428, viewportHeight: 852, pageVisible: true },
      { windowVisible: true, windowMinimized: false, contentWidth: 1441, contentHeight: 900, viewportWidth: 1429, viewportHeight: 852, pageVisible: true },
      { windowVisible: true, windowMinimized: false, contentWidth: 1440, contentHeight: 901, viewportWidth: 1428, viewportHeight: 853, pageVisible: true },
    ];
    const stableSamples = states.reduce(
      (count, state) => nextExecutionSurfaceStableSamples(count, executionSurfaceIssue(state, minimum)),
      0,
    );
    expect(stableSamples).toBe(3);
  });

  it('resets the stable sample count when the surface becomes unusable', () => {
    expect(nextExecutionSurfaceStableSamples(2, 'page_hidden')).toBe(0);
  });
});

describe('evidence capture', () => {
  it('returns the screenshot path when capture succeeds', async () => {
    await expect(captureEvidenceBestEffort(async () => 'evidence.png', 'zhihu', 'fill')).resolves.toEqual({
      screenshotPath: 'evidence.png',
      screenshotWarning: null,
    });
  });

  it('does not fail the operation when the display surface cannot be captured', async () => {
    await expect(captureEvidenceBestEffort(
      async () => { throw new Error('Current display surface not available for capture'); },
      'zhihu',
      'fill',
    )).resolves.toEqual({
      screenshotPath: null,
      screenshotWarning: 'EVIDENCE_CAPTURE_FAILED: zhihu/fill: Current display surface not available for capture',
    });
  });
});

describe('optional editor formatting warnings', () => {
  it('deduplicates additive warnings without changing success semantics', () => {
    expect(formatWarningsFromResult({ status: 'success', formatWarnings: ['小标题', '列表', '小标题'] })).toEqual(['小标题', '列表']);
    expect(formatWarningsFromResult({ status: 'success' })).toBeUndefined();
  });
});
