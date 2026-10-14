import { describe, expect, it } from 'vitest';
import { NsisUpdater } from 'electron-updater';
import { configureUpdaterChannel, isStoreManagedRuntime, updateChannelForVersion, updateFeedUrl, updatePlatformKey, updaterManifestChannel } from './update-manager.js';

// Exercise the installed updater's real channel setter and version comparison.
// The app adapter and rollout callbacks avoid Electron, disk writes and network.
class TestUpdater extends NsisUpdater {
  constructor(version: string) {
    super(null, {
      version, name: 'GEO updater regression test', isPackaged: true,
      appUpdateConfigPath: '', userDataPath: '', baseCachePath: '',
      whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {},
    });
    this.isUpdateSupported = () => true;
    this.isUserWithinRollout = () => true;
  }

  canUpdateTo(version: string): Promise<boolean> {
    // Use the library's internal predicate without starting a download.
    return Reflect.get(this, 'isUpdateAvailable').call(this, {
      version, files: [], path: '', sha512: '', releaseDate: '2026-10-08T00:00:00Z',
    });
  }
}

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

  it('does not downgrade beta.14 to beta.8 when the beta feed is stale', async () => {
    const updater = new TestUpdater('0.6.0-beta.14');
    configureUpdaterChannel(updater, 'beta');
    expect(await updater.canUpdateTo('0.6.0-beta.8')).toBe(false);
    expect(await updater.canUpdateTo('0.6.0-beta.14')).toBe(false);
    expect(await updater.canUpdateTo('0.6.0-beta.15')).toBe(true);
  });

  it('does not downgrade to the old stable release after leaving beta', async () => {
    const updater = new TestUpdater('0.6.0-beta.14');
    configureUpdaterChannel(updater, 'beta');
    configureUpdaterChannel(updater, 'stable');
    expect(await updater.canUpdateTo('0.2.13')).toBe(false);
    expect(await updater.canUpdateTo('0.6.0')).toBe(true);
  });

  it('keeps the installed stable release when opting into an older beta feed', async () => {
    const updater = new TestUpdater('0.6.0');
    configureUpdaterChannel(updater, 'stable');
    configureUpdaterChannel(updater, 'beta');
    expect(await updater.canUpdateTo('0.6.0-beta.14')).toBe(false);
    expect(await updater.canUpdateTo('0.7.0-beta.1')).toBe(true);
  });
});
