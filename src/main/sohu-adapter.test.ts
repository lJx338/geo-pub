import { describe, expect, it } from 'vitest';
import { buildSohuAiDeclarationStateScriptForTest, buildSohuContentScriptForTest } from './sohu-adapter.js';

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

  it('never accepts page or draft-banner text as filled editor content', () => {
    const script = buildSohuContentScriptForTest('标题', '<p>正文内容</p>');
    expect(script).toContain("bodyFilled: bodyVerificationSource === 'editor'");
  });

  it('targets the current Element UI AI declaration control', () => {
    const script = buildSohuAiDeclarationStateScriptForTest(true);
    expect(script).toContain('含有AI生成内容');
    expect(script).not.toContain('包含AI创作内容');
    expect(script).toContain('label.el-radio');
    expect(script).toContain('.el-radio__inner');
    expect(script).toContain('input.checked');
    expect(script).toContain("scrollIntoView({ block: 'center'");
  });
});
