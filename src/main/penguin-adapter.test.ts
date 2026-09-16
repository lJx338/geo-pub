import { describe, expect, it } from 'vitest';
import { normalizePenguinTags, penguinBlockTextsMatch } from './penguin-adapter.js';

describe('企鹅号标签规范化', () => {
  it('splits, de-duplicates, strips hashes, and applies platform limits', () => {
    expect(normalizePenguinTags(['#春日，生活随笔', '春日', '八个字刚好', '超过八个字符的标签'])).toEqual([
      '春日', '生活随笔', '八个字刚好',
    ]);
  });
});

describe('企鹅号正文块校验', () => {
  it('only accepts a complete ordered sequence of normalized editor blocks', () => {
    expect(penguinBlockTextsMatch(['开头', '标题', '列表项'], ['开头', '标\u200B题', '列表项'])).toBe(true);
    expect(penguinBlockTextsMatch(['开头', '标题'], ['开头', '标题', '列表项'])).toBe(false);
    expect(penguinBlockTextsMatch(['开头', '标题', '列表项', '附加'], ['开头', '标题', '列表项'])).toBe(false);
    expect(penguinBlockTextsMatch(['开头', '标题', '其他'], ['开头', '标题', '列表项'])).toBe(false);
  });
});
