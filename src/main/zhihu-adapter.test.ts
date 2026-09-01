import { describe, expect, it } from 'vitest';
import { classifyZhihuInsertionEffect, verifyZhihuDraftState, zhihuHeadingLabels } from './zhihu-adapter.js';

describe('Zhihu heading controls', () => {
  it('keeps H2 and H3 label probes distinct while covering common menu variants', () => {
    expect(zhihuHeadingLabels(2)).toContain('大标题');
    expect(zhihuHeadingLabels(2)).toContain('H2');
    expect(zhihuHeadingLabels(3)).toContain('小标题');
    expect(zhihuHeadingLabels(3)).toContain('H3');
    expect(zhihuHeadingLabels(2)).not.toContain('小标题');
    expect(zhihuHeadingLabels(3)).not.toContain('大标题');
  });
});

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

describe('Zhihu Draft.js insertion effect', () => {
  it('waits for an asynchronously committed block without requesting a fallback', () => {
    expect(classifyZhihuInsertionEffect('已有正文', '已有正文', '新增段落')).toBe('none');
    expect(classifyZhihuInsertionEffect('已有正文', '已有正文\n新增段落', '新增段落')).toBe('applied');
  });

  it('treats partial and duplicate input as uncertain instead of retrying', () => {
    expect(classifyZhihuInsertionEffect('已有正文', '已有正文\n新增', '新增段落')).toBe('uncertain');
    expect(classifyZhihuInsertionEffect('已有正文', '已有正文\n新增段落\n新增段落', '新增段落')).toBe('uncertain');
  });

  it('ignores Draft.js whitespace and list markers when checking the delta', () => {
    expect(classifyZhihuInsertionEffect('第一段', '第一段\n• 第二项', '第二项')).toBe('applied');
  });
});
