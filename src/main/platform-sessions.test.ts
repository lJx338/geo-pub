import { describe, expect, it, vi } from 'vitest';
import { OperationTimeoutError, PlatformSessions, pickEvictionCandidate, platformPartitionName, platformRuntimeState, projectPartitionName, shouldForegroundPlatformAutomation, withOperationDeadline } from './platform-sessions.js';

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
  it('foregrounds Windows editor automation but keeps non-Windows automation background-capable', () => {
    expect(shouldForegroundPlatformAutomation('win32')).toBe(true);
    expect(shouldForegroundPlatformAutomation('darwin')).toBe(false);
    expect(shouldForegroundPlatformAutomation('linux')).toBe(false);
  });

  it('isolates browser storage by customer project and platform', () => {
    expect(projectPartitionName('11111111-1111-4111-8111-111111111111', 'toutiao'))
      .not.toBe(projectPartitionName('22222222-2222-4222-8222-222222222222', 'toutiao'));
    expect(projectPartitionName('11111111-1111-4111-8111-111111111111', 'toutiao'))
      .not.toBe(projectPartitionName('11111111-1111-4111-8111-111111111111', 'zhihu'));
  });
  it('keeps the NetEase login profile isolated by customer project', () => {
    expect(platformPartitionName('11111111-1111-4111-8111-111111111111', 'netease'))
      .not.toBe(platformPartitionName('22222222-2222-4222-8222-222222222222', 'netease'));
    expect(platformPartitionName('11111111-1111-4111-8111-111111111111', 'toutiao'))
      .toBe(projectPartitionName('11111111-1111-4111-8111-111111111111', 'toutiao'));
  });
  it('does not confuse view residency with login state', () => {
    expect(platformRuntimeState(false, false)).toBe('not_loaded');
    expect(platformRuntimeState(true, false)).toBe('resident');
    expect(platformRuntimeState(true, false, true)).toBe('background');
    expect(platformRuntimeState(true, true)).toBe('active');
  });

  it('keeps the active platform hidden while an app dialog is open', () => {
    const visibility: boolean[] = [];
    const bounds: unknown[] = [];
    const managed = {
      platform: 'baijia',
      host: 'interactive',
      view: {
        setVisible: (visible: boolean) => visibility.push(visible),
        setBounds: (value: unknown) => bounds.push(value),
      },
    };
    const sessions = Object.create(PlatformSessions.prototype) as PlatformSessions;
    const internals = sessions as unknown as {
      activePlatform: 'baijia';
      views: Map<string, typeof managed>;
      window: { getContentSize(): [number, number] };
      uiOverlayOpen: boolean;
      restoreManagedView(value: typeof managed): void;
    };
    internals.window = { getContentSize: () => [1360, 900] };
    internals.uiOverlayOpen = false;
    internals.activePlatform = 'baijia';
    internals.views = new Map([['baijia', managed]]);

    sessions.setUiOverlayOpen(true);
    internals.restoreManagedView(managed);
    expect(visibility).toEqual([false, false]);

    sessions.setUiOverlayOpen(false);
    expect(visibility.at(-1)).toBe(true);
    expect(bounds.at(-1)).toEqual({ x: 248, y: 122, width: 1112, height: 778 });
  });
});

describe('operation deadline', () => {
  it('closes a stalled background page before returning a timeout', async () => {
    let closed = false;
    await expect(withOperationDeadline(new Promise<never>(() => undefined), 5, async () => { closed = true; return { screenshotPath: '/tmp/timeout.png' }; })).rejects.toMatchObject({
      message: expect.stringContaining('PLATFORM_OPERATION_TIMEOUT'),
      details: { screenshotPath: '/tmp/timeout.png' },
    } satisfies Partial<OperationTimeoutError>);
    expect(closed).toBe(true);
  });
});


describe('platform history navigation', () => {
  it.each(['goBack', 'goForward'] as const)('%s ignores missing history and still blocks navigation while busy', (action) => {
    const navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    const sessions = Object.create(PlatformSessions.prototype) as PlatformSessions;
    const snapshot = { activePlatform: 'baijia' };
    Object.assign(sessions, {
      activePlatform: 'baijia',
      views: new Map([['baijia', { view: { webContents: { navigationHistory } } }]]),
      pendingOperations: 0,
      status: () => snapshot,
    });

    expect(sessions[action]()).toBe(snapshot);
    expect(navigationHistory[action]).not.toHaveBeenCalled();

    navigationHistory.canGoBack.mockReturnValue(true);
    navigationHistory.canGoForward.mockReturnValue(true);
    expect(sessions[action]()).toBe(snapshot);
    expect(navigationHistory[action]).toHaveBeenCalledTimes(1);

    Object.assign(sessions, { pendingOperations: 1 });
    expect(() => sessions[action]()).toThrow('PUBLISHER_BUSY');
    expect(navigationHistory[action]).toHaveBeenCalledTimes(1);
  });
});
