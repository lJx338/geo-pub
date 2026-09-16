import { describe, expect, it } from 'vitest';
import {
  buildNeteaseEditorEndSelectionScriptForTest,
  countNeteaseExpectedBlocks,
  neteaseEditorNeedsReset,
  neteaseBlockTextsMatch,
  neteaseBlockMismatchIndex,
  verifyNeteaseContentBlocks,
  shouldRetryNeteaseOwnedDraftReset,
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

  it('allows one verified retry when a stale draft returns after the initial clear', () => {
    expect(shouldRetryNeteaseOwnedDraftReset(true, false)).toBe(true);
    expect(shouldRetryNeteaseOwnedDraftReset(true, true)).toBe(false);
    expect(shouldRetryNeteaseOwnedDraftReset(false, false)).toBe(false);
  });

  it('matches Draft.js blocks exactly without flattening list boundaries', () => {
    expect(neteaseBlockTextsMatch(['引言', '第一项', '第二项'], ['引言', '第一项', '第二项'])).toBe(true);
    expect(neteaseBlockTextsMatch(['引言', '第一项第二项'], ['引言', '第一项', '第二项'])).toBe(false);
    expect(neteaseBlockTextsMatch(['引言', '第一项', '第一项', '第二项'], ['引言', '第一项', '第二项'])).toBe(false);
  });

  it('reports only structural mismatch metadata, not article content', () => {
    expect(neteaseBlockMismatchIndex(['引言', '第一项'], ['引言', '第二项'])).toBe(1);
    expect(neteaseBlockMismatchIndex(['引言'], ['引言', '第二项'])).toBe(1);
    expect(neteaseBlockMismatchIndex(['引言'], ['引言'])).toBeNull();
  });

  it('accepts only an exact canonical fallback with the same block count', () => {
    expect(verifyNeteaseContentBlocks(['第一 段', '第二段'], ['第一段', '第二段'])).toBe('equivalent_text');
    expect(verifyNeteaseContentBlocks(['第一段第二段'], ['第一段', '第二段'])).toBe('mismatch');
    expect(verifyNeteaseContentBlocks(['第一段', '第二段', '第二段'], ['第一段', '第二段'])).toBe('mismatch');
  });
});
