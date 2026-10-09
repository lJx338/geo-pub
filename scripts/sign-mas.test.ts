import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), sign: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execute }),
}));
vi.mock('node:fs', () => ({
  realpathSync: (path: string) => path.replace('/Versions/Current/', '/Versions/A/'),
}));
vi.mock('@electron/osx-sign', () => ({ signAsync: mocks.sign }));
// @ts-expect-error The build hook runs directly as JavaScript on the macOS runner.
import signMas from './sign-mas.mjs';

describe('MAS signing handoff', () => {
  const framework = '/Example.app/Contents/Frameworks/Electron Framework.framework';
  const library = `${framework}/Versions/A/Electron Framework`;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ stdout: JSON.stringify([framework, library]), stderr: '' });
    mocks.sign.mockResolvedValue(undefined);
  });

  it('passes a single ignore predicate so osx-sign cannot re-sign libraries with entitlements', async () => {
    const optionsForFile = () => ({ entitlements: 'sandbox.plist' });
    await signMas({
      app: '/Example.app', platform: 'mas', identity: 'distribution-hash', keychain: '/tmp/build.keychain',
      optionsForFile, provisioningProfile: '/tmp/mas.profile',
      ignore: (file: string) => file.endsWith('.kext'),
    });
    const options = mocks.sign.mock.calls[0]![0];
    expect(typeof options.ignore).toBe('function');
    expect(options.ignore(library)).toBe(true);
    expect(options.ignore(library.replace('/Versions/A/', '/Versions/Current/'))).toBe(true);
    expect(options.ignore(framework)).toBe(true);
    expect(options.ignore('/Example.app/Contents/MacOS/Example')).toBe(false);
    expect(options.ignore('/Example.app/Contents/Resources/cli/tool')).toBe(false);
    expect(options.ignore('/Example.app/Contents/Extensions/Driver.kext')).toBe(true);
    expect(options.optionsForFile).toBe(optionsForFile);
    expect(options.provisioningProfile).toBe('/tmp/mas.profile');
    expect(options.identity).toBe('distribution-hash');
  });

  it('stops before app signing if signing a library fails', async () => {
    mocks.execute.mockRejectedValue(new Error('codesign failed'));
    await expect(signMas({ app: '/Example.app', platform: 'mas', identity: 'distribution-hash' }))
      .rejects.toThrow('codesign failed');
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
