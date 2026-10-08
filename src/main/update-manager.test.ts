import { describe, expect, it } from 'vitest';
import { isStoreManagedRuntime, updateChannelForVersion, updateFeedUrl, updatePlatformKey, updaterManifestChannel } from './update-manager.js';

describe('update feed platform selection', () => {
  it('supports Apple Silicon macOS and Windows x64 only', () => {
    expect(updatePlatformKey('darwin', 'arm64')).toBe('mac-arm64');
    expect(updatePlatformKey('darwin', 'x64')).toBeNull();
    expect(updatePlatformKey('win32', 'x64')).toBe('win-x64');
  });

  it('disables unsupported targets', () => {
    expect(updatePlatformKey('linux', 'x64')).toBeNull();
  });

  it('keeps Microsoft Store MSIX updates out of the COS updater', () => {
    expect(isStoreManagedRuntime('win32', true)).toBe(true);
    expect(isStoreManagedRuntime('win32', false)).toBe(false);
    expect(isStoreManagedRuntime('darwin', true)).toBe(false);
  });

  it('keeps Mac App Store updates out of the COS updater while preserving DMG updates', () => {
    expect(isStoreManagedRuntime('darwin', false, true)).toBe(true);
    expect(isStoreManagedRuntime('darwin', false, false)).toBe(false);
  });

  it('keeps prerelease builds on beta and production builds on stable', () => {
    expect(updateChannelForVersion('0.1.0-beta.1')).toBe('beta');
    expect(updateChannelForVersion('0.1.0-alpha.2')).toBe('beta');
    expect(updateChannelForVersion('0.1.0')).toBe('stable');
  });

  it('separates channel pointers from immutable version artifacts', () => {
    expect(updateFeedUrl('stable', 'darwin', 'arm64')).toContain('/releases/channels/stable/mac-arm64');
    expect(updateFeedUrl('beta', 'win32', 'x64')).toContain('/releases/channels/beta/win-x64');
  });

  it('uses the default latest manifest for stable releases', () => {
    expect(updaterManifestChannel('stable')).toBe('latest');
    expect(updaterManifestChannel('beta')).toBe('beta');
  });
});
