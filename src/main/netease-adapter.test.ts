import { describe, expect, it } from 'vitest';
import { buildNeteaseEditorEndSelectionScriptForTest } from './netease-adapter.js';

describe('netease adapter', () => {
  it('places the image insertion caret at the end of the last text block', () => {
    const script = buildNeteaseEditorEndSelectionScriptForTest();
    expect(script).toContain("textNodes.at(-1)");
    expect(script).toContain('range.collapse(false)');
    expect(script).toContain("selectionchange");
  });
});
