import { describe, expect, it } from 'vitest';
import { errorCodeForMessage } from './control-server.js';

describe('control error codes', () => {
  it('preserves a structured adapter error prefix', () => {
    expect(errorCodeForMessage('TOUTIAO_PREVIEW_TIMEOUT: no confirmation dialog')).toBe('TOUTIAO_PREVIEW_TIMEOUT');
  });

  it('uses the generic code for an unstructured exception', () => {
    expect(errorCodeForMessage('unexpected failure')).toBe('CONTROL_REQUEST_FAILED');
  });
});
