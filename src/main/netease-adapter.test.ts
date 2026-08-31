import { describe, expect, it } from 'vitest';
import { buildNeteaseEditorEndSelectionScriptForTest, normalizeNeteaseExpectedFormat } from './netease-adapter.js';

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
});
