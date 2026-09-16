import { describe, expect, it } from 'vitest';
import { cliLauncherPath, controlEndpoint, coreCliPath, dataDirectory } from './runtime-paths.js';

describe('runtime paths', () => {
  it('uses a short per-user local endpoint', () => {
    expect(controlEndpoint()).toContain('geo-publisher-');
    expect(controlEndpoint().length).toBeLessThan(100);
  });

  it('keeps desktop data separate from the extension publisher', () => {
    const directory = dataDirectory();
    const expectedName = process.platform === 'linux' ? 'geo-publisher' : 'GEO Publisher Desktop';

    expect(directory).toContain(expectedName);
    expect(directory).not.toContain('.geo-chrome-publisher');
  });

  it('uses a stable launcher and versioned Core CLI paths', () => {
    const launcher = cliLauncherPath();
    const core = coreCliPath('1.2.3');

    expect(launcher).toContain('bin');
    expect(launcher).not.toContain('versions');
    expect(core).toContain('versions');
    expect(core).toContain('1.2.3');
  });
});
