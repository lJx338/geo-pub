import type { WebContents } from 'electron';
import { cdpClick } from './browser-automation-driver.js';
import { contentMatchesExpected } from './content-verification.js';
import { resumeVisibleDraft } from './editor-draft.js';

const PUBLISH_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1';

export interface SohuDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  bodyVerificationSource: 'editor' | 'page' | 'none';
  title: string;
  bodyTextLength: number;
  formatVerification: {
    expected: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    actual: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    preserved: boolean;
    degradedBlocks: string[];
  };
  formatWarnings?: string[];
  summaryClicked: boolean;
  summaryGenerated: boolean;
  summaryUnavailable: boolean;
  aiContentFound: boolean;
  aiContentSelected: boolean;
  draftSaveState: 'saved';
  publishButtonDetected: boolean;
  url: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const SOHU_AI_DECLARATION_LABEL = '含有AI生成内容';

function publishEntryPointScript(): string {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    })();
    const candidates = [...document.querySelectorAll('button,a,[role="button"],li')]
      .filter(visible)
      .filter((element) => normalize(element.textContent) === '发布内容')
      .sort((left, right) => {
        const leftPrimary = left.matches('button.publish-btn,.publish-btn') ? 1 : 0;
        const rightPrimary = right.matches('button.publish-btn,.publish-btn') ? 1 : 0;
        return rightPrimary - leftPrimary;
      });
    const target = candidates[0];
    if (!(target instanceof HTMLElement)) return null;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
}

export function buildSohuPublishEntryPointScriptForTest(): string {
  return publishEntryPointScript();
}

function draftSaveStateScript(): string {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const text = normalize(document.body?.innerText || document.body?.textContent || '');
    const saving = text.match(/(?:正在)?保存中|正在保存/)?.[0] || '';
    const saved = text.match(/(?:\\d{1,2}:\\d{2}\\s*)?已保存/)?.[0] || '';
    return { saved: Boolean(saved) && !saving, saving: Boolean(saving), label: saving || saved };
  })()`;
}

export function buildSohuDraftSaveStateScriptForTest(): string {
  return draftSaveStateScript();
}

function aiDeclarationStateScript(scroll = false, activate = false): string {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })();
    const text = [...document.querySelectorAll('label.el-radio')].filter(visible).find((element) => normalize(element.textContent) === ${JSON.stringify(SOHU_AI_DECLARATION_LABEL)});
    const root = text;
    if (!(root instanceof HTMLElement)) return { found: false, selected: false, point: null, label: '' };
    const input = root.matches('input[type="radio"]') ? root : root.querySelector('input[type="radio"]');
    const selected = (input instanceof HTMLInputElement && input.checked) || root.getAttribute('aria-checked') === 'true' || /(?:^|\\s)(?:is-checked|checked|selected|active)(?:\\s|$)/.test(String(root.className || ''));
    if (${scroll}) root.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (${activate} && !selected) root.click();
    const target = root.querySelector('.el-radio__inner') || root;
    const rect = target.getBoundingClientRect();
    return { found: true, selected, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, label: normalize(text?.textContent) };
  })()`;
}

export function buildSohuAiDeclarationStateScriptForTest(scroll = false, activate = false): string {
  return aiDeclarationStateScript(scroll, activate);
}

async function clickPoint(webContents: WebContents, point: { x: number; y: number }): Promise<void> {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await delay(120);
  await cdpClick(webContents, { x, y });
}

/**
 * Sohu serves more than one editor tree. Keep discovery, writing and reading
 * in one script so a Vue/Quill/iframe variation cannot produce a false failure.
 */
function contentScript(title: string, html: string, write: boolean, runtimePlatform = process.platform): string {
  return `(async () => {
    const normalize = (value) => String(value || '').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const contentMatchesExpected = ${contentMatchesExpected.toString()};
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const documents = [];
    const collect = (current, depth = 0) => {
      if (!current || documents.includes(current) || depth > 2) return;
      documents.push(current);
      for (const frame of current.querySelectorAll('iframe')) {
        try { if (frame.contentDocument) collect(frame.contentDocument, depth + 1); } catch {}
      }
    };
    collect(document);
    const isElement = (element) => Boolean(element && typeof element.getBoundingClientRect === 'function' && element.ownerDocument);
    const isInput = (element) => isElement(element) && element.tagName === 'INPUT';
    const isTextarea = (element) => isElement(element) && element.tagName === 'TEXTAREA';
    const visible = (element) => isElement(element) && (() => {
      const rect = element.getBoundingClientRect();
      const view = element.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const meta = (element) => normalize([element?.getAttribute?.('placeholder'), element?.getAttribute?.('data-placeholder'), element?.getAttribute?.('aria-label'), element?.getAttribute?.('title'), element?.className].join(' '));
    const candidates = documents.flatMap((current) => [...current.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')]).filter(visible);
    for (const current of documents.slice(1)) if (isElement(current.body) && visible(current.body) && !candidates.includes(current.body)) candidates.push(current.body);
    const titleElement = candidates.map((element) => ({ element, score: (meta(element).includes('标题') ? 500 : 0) + (isInput(element) || isTextarea(element) ? 100 : 0) }))
      .sort((left, right) => right.score - left.score)[0]?.element || null;
    const holder = document.createElement('div'); holder.innerHTML = ${JSON.stringify(html)};
    const expectedBody = normalize(holder.innerText || holder.textContent || '');
    const countStructure = (root) => ({ headings: root.querySelectorAll('h2,h3').length, lists: root.querySelectorAll('ul,ol').length, quotes: root.querySelectorAll('blockquote').length, dividers: root.querySelectorAll('hr').length, images: root.querySelectorAll('img').length });
    const expectedStructure = countStructure(holder);
    const findQuill = (element) => {
      const roots = []; let node = element;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) if (node.__vue__) roots.push(node.__vue__);
      const candidates = [element?.__quill, element?.closest?.('.ql-container')?.__quill];
      try { candidates.push(element?.ownerDocument?.defaultView?.Quill?.find?.(element)); } catch {}
      const seen = new Set();
      for (const root of roots) {
        if (!root || seen.has(root)) continue;
        seen.add(root);
        candidates.push(root.quill, root.editor?.quill, root.$refs?.editor?.quill, root.$refs?.quillEditor?.quill,
          root.$refs?.articleEditor?.quill, root.$refs?.contentEditor?.quill);
        if (Array.isArray(root.$children)) candidates.push(...root.$children.slice(0, 30).flatMap((child) => [child?.quill, child?.editor?.quill]));
      }
      return candidates.find((candidate) => typeof candidate?.getText === 'function' && typeof candidate?.clipboard?.dangerouslyPasteHTML === 'function') || null;
    };
    const readValues = (element) => {
      const values = isInput(element) || isTextarea(element) ? [element.value] : [element.innerText, element.textContent];
      const quill = findQuill(element);
      try { if (typeof quill?.getText === 'function') values.push(quill.getText()); } catch {}
      return values.map(normalize).filter(Boolean);
    };
    const bodyCandidates = candidates.filter((element) => element !== titleElement).map((element) => {
      const values = readValues(element);
      const explicitEditor = element.matches('.ql-editor,.ProseMirror,.article-editor,[data-editor],[data-placeholder*="正文"]') || Boolean(element.closest?.('.ql-container,.article-editor')) || element.ownerDocument !== document;
      const score = (explicitEditor ? 600 : 0) + (meta(element).includes('正文') ? 350 : 0) + (meta(element).toLowerCase().includes('editor') ? 150 : 0) + (element.getBoundingClientRect().height > 160 ? 120 : 0) + (values.some((value) => contentMatchesExpected(value, expectedBody)) ? 1000 : 0);
      return { element, values, score };
    }).sort((left, right) => right.score - left.score);
    const bodyElement = bodyCandidates[0]?.element || null;
    const dispatchChanges = (element, value, inputType = 'insertReplacementText') => {
      const view = element.ownerDocument?.defaultView || window;
      try { element.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType, data: value })); } catch { element.dispatchEvent(new view.Event('input', { bubbles: true })); }
      element.dispatchEvent(new view.Event('change', { bubbles: true })); element.dispatchEvent(new view.Event('blur', { bubbles: true }));
    };
    const setValue = (element, value) => {
      const view = element.ownerDocument?.defaultView || window;
      const prototype = isTextarea(element) ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, value); else element.value = value;
      dispatchChanges(element, value);
    };
    let writeMethod = 'read_only';
    if (${write}) {
      if (isInput(titleElement) || isTextarea(titleElement)) setValue(titleElement, ${JSON.stringify(title)});
      else if (isElement(titleElement)) { titleElement.replaceChildren(titleElement.ownerDocument.createTextNode(${JSON.stringify(title)})); dispatchChanges(titleElement, ${JSON.stringify(title)}); }
      if (isInput(bodyElement) || isTextarea(bodyElement)) { setValue(bodyElement, expectedBody); writeMethod = 'native_value'; }
      else if (isElement(bodyElement)) {
        bodyElement.scrollIntoView({ block: 'center', inline: 'nearest' }); bodyElement.focus({ preventScroll: true });
        const quill = findQuill(bodyElement);
        let editorApiWrote = false;
        try { if (typeof quill?.clipboard?.dangerouslyPasteHTML === 'function') { quill.setText?.(''); quill.clipboard.dangerouslyPasteHTML(0, ${JSON.stringify(html)}, 'api'); editorApiWrote = true; writeMethod = 'quill_html'; } } catch {}
        if (!editorApiWrote) {
          const root = bodyElement.closest?.('.article-container') || bodyElement.closest?.('.container-section')?.parentElement;
          const articleComponent = root?.__vue__; const editorComponent = bodyElement.parentElement?.parentElement?.__vue__;
          try {
            if (typeof articleComponent?.setEditorContent === 'function') { articleComponent.setEditorContent(${JSON.stringify(html)}); articleComponent.content = ${JSON.stringify(html)}; editorApiWrote = true; writeMethod = 'vue_article'; }
            else if (typeof editorComponent?.setHTML === 'function') { editorComponent.setHTML(${JSON.stringify(html)}); editorApiWrote = true; writeMethod = 'vue_editor'; }
          } catch {}
        }
        await pause(180);
        ${runtimePlatform === 'win32' ? '' : `if (!readValues(bodyElement).some((value) => contentMatchesExpected(value, expectedBody))) { bodyElement.innerHTML = ${JSON.stringify(html)}; writeMethod = 'dom_fallback'; }`}
        dispatchChanges(bodyElement, expectedBody, 'insertFromPaste');
      }
      const fingerprint = (value) => { const text=String(value||''); let hash=2166136261; for(let i=0;i<text.length;i+=1){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);} return (hash>>>0).toString(16).padStart(8,'0'); };
      const sample = (afterMs) => {
        const quill=isElement(bodyElement)?findQuill(bodyElement):null;
        let quillText=''; let delta='';
        try { quillText=String(quill?.getText?.()||''); delta=JSON.stringify(quill?.getContents?.()?.ops||[]); } catch {}
        const domText=isElement(bodyElement)?String(bodyElement.innerText||bodyElement.textContent||''):'';
        const pageText=String(document.body?.innerText||'');
        return { afterMs, domLength:domText.length, domFingerprint:fingerprint(domText), quillLength:quillText.length,
          quillFingerprint:fingerprint(quillText), deltaLength:delta.length, deltaFingerprint:fingerprint(delta),
          saving:/保存中/.test(pageText), saved:/已保存|草稿已保存/.test(pageText) };
      };
      const samples=[]; await pause(100); samples.push(sample(100)); await pause(400); samples.push(sample(500)); await pause(1500); samples.push(sample(2000));
      window.__geoPublisherLastWrite = { adapter: 'sohu', writeMethod, editorFound: Boolean(bodyElement), quillFound: Boolean(isElement(bodyElement) && findQuill(bodyElement)), expectedLength: expectedBody.length, samples, recordedAt: Date.now() };
      if (${JSON.stringify(runtimePlatform)} === 'win32' && !readValues(bodyElement).some((value) => contentMatchesExpected(value, expectedBody))) throw new Error('SOHU_EDITOR_MODEL_NOT_UPDATED: Windows 搜狐编辑器未确认内部模型已更新');
    }
    const actualTitle = normalize(isInput(titleElement) || isTextarea(titleElement) ? titleElement.value : titleElement?.textContent);
    const actualBodies = bodyCandidates.flatMap(({ element }) => readValues(element));
    const pageBodies = documents.map((current) => normalize(current.body?.innerText || current.body?.textContent || ''));
    const editorMatch = actualBodies.some((body) => contentMatchesExpected(body, expectedBody));
    const pageMatch = pageBodies.some((body) => contentMatchesExpected(body, expectedBody));
    const bodyVerificationSource = editorMatch ? 'editor' : pageMatch ? 'page' : 'none';
    const actualBody = [...actualBodies].sort((left, right) => right.length - left.length)[0] || '';
    const actualStructure = isElement(bodyElement) ? countStructure(bodyElement) : { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 };
    const labels = { headings: '小标题', lists: '列表', quotes: '引用', dividers: '分隔线', images: '正文图片' };
    const degradedBlocks = Object.keys(expectedStructure).filter((key) => actualStructure[key] < expectedStructure[key]).map((key) => labels[key]);
    if (bodyVerificationSource !== 'editor' && degradedBlocks.length === 0 && Object.values(expectedStructure).some(Boolean)) degradedBlocks.push('编辑器结构无法确认');
    return { titleFilled: actualTitle === normalize(${JSON.stringify(title)}), bodyFilled: bodyVerificationSource === 'editor', bodyVerificationSource, title: actualTitle, bodyTextLength: actualBody.length, formatVerification: { expected: expectedStructure, actual: actualStructure, preserved: degradedBlocks.length === 0, degradedBlocks }, editorFound: Boolean(titleElement && bodyElement), documentCount: documents.length, bodyCandidateCount: bodyCandidates.length, writeMethod, lastWrite: window.__geoPublisherLastWrite || null };
  })()`;
}

// Keep the default fixture deterministic on Windows; production calls pass
// the real process platform through contentScript directly.
export function buildSohuContentScriptForTest(title: string, html: string, write = false, runtimePlatform: NodeJS.Platform = 'linux'): string {
  return contentScript(title, html, write, runtimePlatform);
}

export async function ensureSohuEditor(webContents: WebContents, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  let entryAttempts = 0;
  let directNavigationAttempted = false;
  let nextEntryAttemptAt = 0;
  let resumeAttempted = false;
  while (Date.now() < deadline) {
    const state = await webContents.executeJavaScript(`(() => {
      const visible = (element) => Boolean(element && typeof element.getBoundingClientRect === 'function' && (() => { const rect = element.getBoundingClientRect(); const view = element.ownerDocument?.defaultView || window; const style = view.getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })());
      const text = String(document.body?.innerText || '');
      const blocking = [...document.querySelectorAll('[role="dialog"],.tcaptcha-transform,.verify-box')].filter(visible).some((element) => /验证码|安全验证|拖动下方滑块完成拼图|风险验证/.test(String(element.textContent || '')));
      const documents = [document];
      for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) documents.push(frame.contentDocument); } catch {} }
      const editables = documents.flatMap((current) => [...current.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')]).filter(visible);
      return { ready: editables.length >= 2 || (editables.length >= 1 && documents.length > 1), loginBlocked: /请登录后继续|登录后发布|扫码登录|重新登录/.test(text) || /login|passport/i.test(location.href), blocking };
    })()`);
    if (state.loginBlocked) throw new Error('SOHU_LOGIN_REQUIRED: 请在桌面端完成搜狐号登录');
    if (state.blocking) throw new Error('SOHU_VERIFICATION_REQUIRED: 搜狐号显示了可见验证码或安全验证');
    streak = state.ready ? streak + 1 : 0;
    if (streak >= 3 && !resumeAttempted) {
      resumeAttempted = true;
      const resumed = await resumeVisibleDraft(webContents);
      if (resumed) {
        // Resuming a saved draft swaps the editor's Vue/Quill model. Wait for
        // the replacement editor to settle before any content is overwritten.
        streak = 0;
        await delay(1_500);
        continue;
      }
    }
    if (streak >= 3) {
      return;
    }

    const currentUrl = webContents.getURL();
    if (!currentUrl.includes('/contentManagement/news/addarticle') && Date.now() >= nextEntryAttemptAt) {
      const point = await webContents.executeJavaScript(publishEntryPointScript()).catch(() => null);
      if (point && entryAttempts < 3) {
        await clickPoint(webContents, point);
        entryAttempts += 1;
        nextEntryAttemptAt = Date.now() + 3_000;
        await delay(900);
        continue;
      }
      if (!directNavigationAttempted) {
        directNavigationAttempted = true;
        try {
          await webContents.loadURL(PUBLISH_URL);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/ERR_ABORTED \(-3\)/.test(message)) throw error;
        }
        await delay(700);
        continue;
      }
    }
    await delay(700);
  }
  throw new Error('SOHU_EDITOR_NOT_READY: 搜狐号编辑器 120 秒内未就绪');
}

async function waitForSohuDraftSaved(webContents: WebContents, timeoutMs = 20_000): Promise<'saved'> {
  const deadline = Date.now() + timeoutMs;
  let savedStreak = 0;
  while (Date.now() < deadline) {
    const state = await webContents.executeJavaScript(draftSaveStateScript());
    savedStreak = state.saved ? savedStreak + 1 : 0;
    if (savedStreak >= 2) return 'saved';
    await delay(500);
  }
  throw new Error('SOHU_DRAFT_SAVE_TIMEOUT: 搜狐号草稿未在限定时间内确认保存');
}

async function fillContent(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean; bodyVerificationSource: 'editor' | 'page' | 'none'; title: string; bodyTextLength: number; formatVerification: SohuDraftFillResult['formatVerification'] }> {
  await webContents.executeJavaScript(contentScript(title, html, true));
  await delay(900);
  let result = await webContents.executeJavaScript(contentScript(title, html, false));
  for (let attempt = 0; attempt < 15 && (!result.titleFilled || !result.bodyFilled || !result.formatVerification.preserved); attempt += 1) {
    await delay(600 + Math.min(attempt, 6) * 150);
    result = await webContents.executeJavaScript(contentScript(title, html, false));
  }
  return result;
}

async function applyOptionalSettings(webContents: WebContents): Promise<{ summaryClicked: boolean; summaryGenerated: boolean; summaryUnavailable: boolean; aiContentFound: boolean; aiContentSelected: boolean }> {
  let ai = await webContents.executeJavaScript(aiDeclarationStateScript(true));
  for (let attempt = 0; ai.found && !ai.selected && attempt < 3; attempt += 1) {
    await delay(350 + attempt * 250);
    ai = await webContents.executeJavaScript(aiDeclarationStateScript(true));
    if (ai.selected) break;
    await webContents.executeJavaScript(aiDeclarationStateScript(true, true));
    await delay(400);
    ai = await webContents.executeJavaScript(aiDeclarationStateScript(false));
    if (ai.selected) break;
    if (ai.point) await clickPoint(webContents, ai.point);
    await delay(700 + attempt * 300);
    ai = await webContents.executeJavaScript(aiDeclarationStateScript(false));
  }
  return { summaryClicked: false, summaryGenerated: false, summaryUnavailable: false, aiContentFound: ai.found, aiContentSelected: ai.selected };
}

export async function fillSohuDraft(webContents: WebContents, title: string, html: string): Promise<SohuDraftFillResult> {
  await ensureSohuEditor(webContents);
  const content = await fillContent(webContents, title, html);
  if (!content.titleFilled || !content.bodyFilled) throw new Error(`SOHU_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  const formatWarnings = content.formatVerification.preserved ? [] : [...content.formatVerification.degradedBlocks];
  await delay(1_000);
  const beforeSettings = await webContents.executeJavaScript(contentScript(title, html, false));
  if (!beforeSettings.titleFilled || !beforeSettings.bodyFilled) throw new Error(`SOHU_CONTENT_NOT_STABLE_BEFORE_SETTINGS: title=${beforeSettings.titleFilled}, body=${beforeSettings.bodyFilled}`);
  if (!beforeSettings.formatVerification.preserved) formatWarnings.push(...beforeSettings.formatVerification.degradedBlocks.filter((item: string) => !formatWarnings.includes(item)));
  const optional = await applyOptionalSettings(webContents);
  if (!optional.aiContentFound) throw new Error('SOHU_AI_DECLARATION_NOT_FOUND: 未找到搜狐号“含有AI生成内容”声明');
  if (!optional.aiContentSelected) throw new Error('SOHU_AI_DECLARATION_NOT_SELECTED: 搜狐号“含有AI生成内容”声明未选中');
  const stableContent = await webContents.executeJavaScript(contentScript(title, html, false));
  if (!stableContent.titleFilled || !stableContent.bodyFilled) throw new Error(`SOHU_CONTENT_NOT_STABLE: title=${stableContent.titleFilled}, body=${stableContent.bodyFilled}`);
  if (!stableContent.formatVerification.preserved) formatWarnings.push(...stableContent.formatVerification.degradedBlocks.filter((item: string) => !formatWarnings.includes(item)));
  const draftSaveState = await waitForSohuDraftSaved(webContents);
  const finalState = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const publishButtonDetected = [...document.querySelectorAll('li.publish-report-btn,li[report-attr],button,[role="button"]')].filter(visible).some((element) => { const text = normalize(element.textContent); return text === '发布' && !text.includes('定时发布') && !element.hasAttribute('disabled'); });
    const ai = [...document.querySelectorAll('label.el-radio')].filter(visible).find((element) => normalize(element.textContent) === ${JSON.stringify(SOHU_AI_DECLARATION_LABEL)}); if (ai instanceof HTMLElement) ai.scrollIntoView({ block: 'center' });
    return { publishButtonDetected, url: location.href };
  })()`);
  await delay(500);
  return { ...content, ...stableContent, ...(formatWarnings.length ? { formatWarnings } : {}), ...optional, draftSaveState, ...finalState };
}
