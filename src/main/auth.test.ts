import { describe, expect, it } from 'vitest';
import { controlEndpoint, dataDirectory } from './runtime-paths.js';

describe('runtime paths', () => {
  it('uses a short per-user local endpoint', () => {
    expect(controlEndpoint()).toContain('geo-publisher-');
    expect(controlEndpoint().length).toBeLessThan(100);
  });

  it('keeps desktop data separate from the extension publisher', () => {
    expect(dataDirectory()).toContain('GEO Publisher Desktop');
    expect(dataDirectory()).not.toContain('.geo-chrome-publisher');
  });
});
