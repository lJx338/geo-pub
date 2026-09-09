import { describe, expect, it } from 'vitest';
import {
  buildNeteaseEditorEndSelectionScriptForTest,
  countNeteaseExpectedBlocks,
  neteaseEditorNeedsReset,
  normalizeNeteaseExpectedFormat,
} from './netease-adapter.js';

describe('netease adapter', () => {
  it('places the image insertion caret at the end of the last text block', () => {
    const script = buildNeteaseEditorEndSelectionScriptForTest();
    expect(script).toContain("textNodes.at(-1)");
    expect(script).toContain('range.collapse(false)');
    expect(script).toContain("selectionchange");
  });

  it('does not require unsupported source dividers to survive Draft.js input', () => {
    expect(normalizeNeteaseExpectedFormat({
      headings: 2,
      lists: 1,
      quotes: 1,
      dividers: 3,
      images: 1,
    })).toEqual({ headings: 2, lists: 1, quotes: 1, dividers: 0, images: 1 });
  });

  it('counts top-level blocks without double-counting a quote paragraph', () => {
    expect(countNeteaseExpectedBlocks([
      { tag: 'p', text: '引言', listItemCount: 0 },
      { tag: 'blockquote', text: '引用内容', listItemCount: 0 },
      { tag: 'hr', text: '', listItemCount: 0 },
      { tag: 'ul', text: '第一项 第二项', listItemCount: 2 },
    ])).toBe(4);
  });

  it('requests a reset only when an editor contains text or images', () => {
    expect(neteaseEditorNeedsReset({ textLength: 0, imageCount: 0 })).toBe(false);
    expect(neteaseEditorNeedsReset({ textLength: 3, imageCount: 0 })).toBe(true);
    expect(neteaseEditorNeedsReset({ textLength: 0, imageCount: 1 })).toBe(true);
  });
});
