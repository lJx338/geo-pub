import { describe, expect, it } from 'vitest';
import { pickEvictionCandidate, platformRuntimeState } from './platform-sessions.js';

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
    expect(platformRuntimeState(true, false, true)).toBe('background');
    expect(platformRuntimeState(true, true)).toBe('active');
  });
});
