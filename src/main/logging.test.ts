import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportError } from './logging.js';

describe('reportError', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ignores a closed output pipe', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    });

    expect(() => reportError('renderer error')).not.toThrow();
  });

  it('does not hide unrelated logging failures', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('unexpected failure');
    });

    expect(() => reportError('renderer error')).toThrow('unexpected failure');
  });
});
