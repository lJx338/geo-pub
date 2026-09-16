import { describe, expect, it } from 'vitest';
import {
  buildSohuAiDeclarationStateScriptForTest,
  buildSohuContentScriptForTest,
  buildSohuDraftSaveStateScriptForTest,
  buildSohuPublishEntryPointScriptForTest,
} from './sohu-adapter.js';

describe('Sohu editor compatibility', () => {
  it('uses the logged-in publish entry when a reused tab is on the content list', () => {
    const script = buildSohuPublishEntryPointScriptForTest();
    expect(script).toContain("normalize(element.textContent) === '发布内容'");
    expect(script).toContain('button.publish-btn');
    expect(script).toContain('getBoundingClientRect');
  });

  it('waits for the platform save indicator before publishing', () => {
    const script = buildSohuDraftSaveStateScriptForTest();
    expect(script).toContain('已保存');
    expect(script).toContain('保存中');
    expect(script).toContain('Boolean(saved) && !saving');
  });

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
    expect(script).toContain('__geoPublisherLastWrite');
    expect(script).toContain("writeMethod = 'quill_html'");
    expect(script).toContain("writeMethod = 'dom_fallback'");
  });

  it('keeps Windows Quill discovery bounded and does not emit a DOM body fallback', () => {
    const script = buildSohuContentScriptForTest('标题', '<p>正文内容</p>', true, 'win32');
    expect(script).toContain('depth < 7');
    expect(script).toContain('$children.slice(0, 30)');
    expect(script).toContain('$refs?.articleEditor?.quill');
    expect(script).not.toContain('Object.values(root.$refs)');
    expect(script).not.toContain('bodyElement.innerHTML');
    expect(script).toContain('SOHU_EDITOR_MODEL_NOT_UPDATED');
  });

  it('samples the Quill model, DOM, and save signal after a Windows write', () => {
    const script = buildSohuContentScriptForTest('标题', '<p>正文内容</p>', true, 'win32');
    expect(script).toContain('sample(100)');
    expect(script).toContain('sample(500)');
    expect(script).toContain('sample(2000)');
    expect(script).toContain('deltaFingerprint');
    expect(script).toContain("saving:/保存中/");
  });

  it('accepts intact ordered editor blocks without weakening Quill model verification', () => {
    const script = buildSohuContentScriptForTest('标题', '<h2>小标题</h2><ul><li>列表项</li></ul><p>正文内容</p>', true, 'win32');
    expect(script).toContain('contentContainsExpectedBlocks');
    expect(script).toContain('expectedBlocks');
    expect(script).toContain('editorModelMatches');
    expect(script).toContain('quill.getText()');
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

  it('can activate the declaration through the page DOM', () => {
    const script = buildSohuAiDeclarationStateScriptForTest(true, true);
    expect(script).toContain('root.click()');
  });
});
