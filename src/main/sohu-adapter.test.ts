import { describe, expect, it } from 'vitest';
import { buildSohuContentScriptForTest } from './sohu-adapter.js';

describe('Sohu editor compatibility', () => {
  it('discovers more than the legacy ql-editor selector', () => {
    const script = buildSohuContentScriptForTest('标题', '<p>正文内容</p>');
    expect(script).toContain(".ql-editor,.ProseMirror,.article-editor,[data-editor]");
    expect(script).toContain("current.querySelectorAll('iframe')");
    expect(script).toContain('contentDocument');
  });

  it('uses an editor API when available and retains a DOM fallback', () => {
    const script = buildSohuContentScriptForTest('标题', '<p>正文内容</p>', true);
    expect(script).toContain('dangerouslyPasteHTML');
    expect(script).toContain('setEditorContent');
    expect(script).toContain('bodyElement.innerHTML');
    expect(script).toContain('countStructure');
    expect(script).toContain('formatVerification');
  });
});
