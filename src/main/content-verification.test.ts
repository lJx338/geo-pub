import { describe, expect, it } from 'vitest';
import { classifyDraftBlockCount, contentContainsExpectedBlocks, contentMatchesExpected } from './content-verification.js';

const expected = '开头内容用于确认正文。中间部分说明发布前需要核对事实和结构。结尾内容用于确认文章没有被截断。';

describe('contentMatchesExpected', () => {
  it('accepts exact and zero-width-normalized content', () => {
    expect(contentMatchesExpected(expected, expected)).toBe(true);
    expect(contentMatchesExpected(expected.replace('中间部分', '中间\u200B部分'), expected)).toBe(true);
  });

  it('rejects surrounding page text, changed punctuation, and duplicate content', () => {
    expect(contentMatchesExpected(`页面前缀 ${expected} 页面后缀`, expected)).toBe(false);
    expect(contentMatchesExpected(expected.replace('事实和结构', '事实、结构'), expected)).toBe(false);
    expect(contentMatchesExpected(`${expected}${expected}`, expected)).toBe(false);
  });

  it('rejects empty, short, or unrelated editor content', () => {
    expect(contentMatchesExpected('', expected)).toBe(false);
    expect(contentMatchesExpected('开头内容用于确认正文。', expected)).toBe(false);
    expect(contentMatchesExpected('这是侧栏里的其他文字，与文章正文无关。'.repeat(5), expected)).toBe(false);
  });
});

describe('contentContainsExpectedBlocks', () => {
  const blocks = ['第一段完整正文。', '小标题', '列表第一项', '列表第二项', '最后一段完整正文。'];

  it('accepts intact ordered blocks with editor separators and list markers', () => {
    expect(contentContainsExpectedBlocks('第一段完整正文。 小标题 • 列表第一项 • 列表第二项 最后一段完整正文。', blocks)).toBe(true);
  });

  it('rejects missing, reordered, duplicated, or unrelated editor content', () => {
    expect(contentContainsExpectedBlocks('第一段完整正文。 小标题 列表第一项 最后一段完整正文。', blocks)).toBe(false);
    expect(contentContainsExpectedBlocks('第一段完整正文。 小标题 列表第二项 列表第一项 最后一段完整正文。', blocks)).toBe(false);
    expect(contentContainsExpectedBlocks(`${blocks.join(' ')} ${blocks.join(' ')}`, blocks)).toBe(false);
    expect(contentContainsExpectedBlocks(`无关内容${'很长'.repeat(40)} ${blocks.join(' ')}`, blocks)).toBe(false);
  });
});

describe('Draft.js block structure', () => {
  it('distinguishes a collapsed document from duplicate paragraph creation', () => {
    expect(classifyDraftBlockCount(6, 6)).toBe('match');
    expect(classifyDraftBlockCount(6, 1)).toBe('missing');
    expect(classifyDraftBlockCount(6, 7)).toBe('duplicate');
  });
});
