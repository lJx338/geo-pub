import { describe, expect, it } from 'vitest';
import { updateChannelForVersion, updatePlatformKey } from './update-manager.js';

describe('update feed platform selection', () => {
  it('separates mac architectures and Windows', () => {
    expect(updatePlatformKey('darwin', 'arm64')).toBe('mac-arm64');
    expect(updatePlatformKey('darwin', 'x64')).toBe('mac-x64');
    expect(updatePlatformKey('win32', 'x64')).toBe('win-x64');
  });

  it('disables unsupported targets', () => {
    expect(updatePlatformKey('linux', 'x64')).toBeNull();
  });

  it('keeps prerelease builds on beta and production builds on stable', () => {
    expect(updateChannelForVersion('0.1.0-beta.1')).toBe('beta');
    expect(updateChannelForVersion('0.1.0-alpha.2')).toBe('beta');
    expect(updateChannelForVersion('0.1.0')).toBe('stable');
  });
});
