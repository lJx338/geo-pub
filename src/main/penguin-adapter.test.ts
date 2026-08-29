import { describe, expect, it } from 'vitest';
import { normalizePenguinTags } from './penguin-adapter.js';

describe('企鹅号标签规范化', () => {
  it('splits, de-duplicates, strips hashes, and applies platform limits', () => {
    expect(normalizePenguinTags(['#春日，生活随笔', '春日', '八个字刚好', '超过八个字符的标签'])).toEqual([
      '春日', '生活随笔', '八个字刚好',
    ]);
  });
});
