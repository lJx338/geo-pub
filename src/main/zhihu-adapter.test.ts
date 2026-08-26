import { describe, expect, it } from 'vitest';
import { verifyZhihuDraftState } from './zhihu-adapter.js';

describe('Zhihu draft verification', () => {
  it('does not accept editor-only samples while the platform word count is zero', () => {
    expect(verifyZhihuDraftState({
      titleFilled: true,
      bodyFilled: true,
      stableSamples: 3,
      wordCount: 0,
      expectedTextLength: 800,
    })).toEqual({ verified: false, source: 'none' });
  });

  it('prefers the platform word count when it has caught up', () => {
    expect(verifyZhihuDraftState({
      titleFilled: true,
      bodyFilled: true,
      stableSamples: 1,
      wordCount: 600,
      expectedTextLength: 800,
    })).toEqual({ verified: true, source: 'word_count' });
  });

  it('never accepts missing, partial, or unstable editor content', () => {
    expect(verifyZhihuDraftState({ titleFilled: true, bodyFilled: false, stableSamples: 3, wordCount: 0, expectedTextLength: 800 }).verified).toBe(false);
    expect(verifyZhihuDraftState({ titleFilled: true, bodyFilled: true, stableSamples: 2, wordCount: 0, expectedTextLength: 800 }).verified).toBe(false);
    expect(verifyZhihuDraftState({ titleFilled: false, bodyFilled: true, stableSamples: 3, wordCount: 800, expectedTextLength: 800 }).verified).toBe(false);
  });
});
