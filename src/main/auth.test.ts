import { describe, expect, it } from 'vitest';
import { controlEndpoint, dataDirectory } from './runtime-paths.js';

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
});
