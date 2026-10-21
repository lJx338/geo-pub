import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
// @ts-expect-error The packaging configuration is loaded directly by Node on macOS.
import { masConfig } from './mas-config.mjs';

describe('Mac App Store identity', () => {
  it('shares the display name while preserving the bundle and CLI identities', () => {
    const config = masConfig({ MAS_PROFILE_PATH: '/test/profile', MAS_BUILD_NUMBER: '13.1' });
    expect(config.productName).toBe('Lingxi Workspace');
    expect(config.appId).toBe('com.lingxi.geo-publisher');
    expect(config.mas.binaries).toEqual(['Contents/Resources/cli/geo-publisher-darwin-arm64']);
    expect(packageJson.name).toBe('geo-publisher-desktop');
    expect(config.mas.bundleShortVersion).toBe(packageJson.version);
    expect(config.mas.bundleVersion).toBe('13.1');
    expect(packageJson.build.productName).toBe('Lingxi Workspace');
  });

  it('rejects a store version override that would differ from the displayed application version', () => {
    expect(() => masConfig({ MAS_PROFILE_PATH: '/test/profile', MAS_APP_VERSION: '1.0.13' }))
      .toThrow('must match the application version');
  });
});
