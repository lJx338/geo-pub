import { describe, expect, it } from 'vitest';
import { contentMatchesExpected } from './content-verification.js';

const expected = '开头内容用于确认正文。中间部分说明发布前需要核对事实和结构。结尾内容用于确认文章没有被截断。';

describe('contentMatchesExpected', () => {
  it('accepts exact and zero-width-normalized content', () => {
    expect(contentMatchesExpected(expected, expected)).toBe(true);
    expect(contentMatchesExpected(expected.replace('中间部分', '中间\u200B部分'), expected)).toBe(true);
  });

  it('accepts platform-normalized content when multiple samples remain', () => {
    expect(contentMatchesExpected(`页面前缀 ${expected.replace('事实和结构', '事实、结构')} 页面后缀`, expected)).toBe(true);
  });

  it('rejects empty, short, or unrelated editor content', () => {
    expect(contentMatchesExpected('', expected)).toBe(false);
    expect(contentMatchesExpected('开头内容用于确认正文。', expected)).toBe(false);
    expect(contentMatchesExpected('这是侧栏里的其他文字，与文章正文无关。'.repeat(5), expected)).toBe(false);
  });
});

