import type { WebContents } from 'electron';
import { contentMatchesExpected } from './content-verification.js';

const PUBLISH_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1';

export interface SohuDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  bodyVerificationSource: 'editor' | 'page' | 'none';
  title: string;
  bodyTextLength: number;
  summaryClicked: boolean;
  summaryGenerated: boolean;
  summaryUnavailable: boolean;
  aiContentFound: boolean;
  aiContentSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function clickPoint(webContents: WebContents, point: { x: number; y: number }): Promise<void> {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await delay(120);
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/**
 * Sohu serves more than one editor tree. Keep discovery, writing and reading
 * in one script so a Vue/Quill/iframe variation cannot produce a false failure.
 */
function contentScript(title: string, html: string, write: boolean): string {
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
    const readValues = (element) => {
      const values = isInput(element) || isTextarea(element) ? [element.value] : [element.innerText, element.textContent];
      const container = element.closest?.('.ql-container'); const view = element.ownerDocument?.defaultView || window;
      let quill = element.__quill || container?.__quill;
      try { quill ||= view.Quill?.find?.(element) || view.Quill?.find?.(container); } catch {}
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
    if (${write}) {
      if (isInput(titleElement) || isTextarea(titleElement)) setValue(titleElement, ${JSON.stringify(title)});
      else if (isElement(titleElement)) { titleElement.replaceChildren(titleElement.ownerDocument.createTextNode(${JSON.stringify(title)})); dispatchChanges(titleElement, ${JSON.stringify(title)}); }
      if (isInput(bodyElement) || isTextarea(bodyElement)) setValue(bodyElement, expectedBody);
      else if (isElement(bodyElement)) {
        bodyElement.scrollIntoView({ block: 'center', inline: 'nearest' }); bodyElement.focus({ preventScroll: true });
        const container = bodyElement.closest?.('.ql-container'); const view = bodyElement.ownerDocument?.defaultView || window;
        let quill = bodyElement.__quill || container?.__quill; try { quill ||= view.Quill?.find?.(bodyElement) || view.Quill?.find?.(container); } catch {}
        let editorApiWrote = false;
        try { if (typeof quill?.clipboard?.dangerouslyPasteHTML === 'function') { quill.setText?.(''); quill.clipboard.dangerouslyPasteHTML(0, ${JSON.stringify(html)}, 'api'); editorApiWrote = true; } } catch {}
        if (!editorApiWrote) {
          const root = bodyElement.closest?.('.article-container') || bodyElement.closest?.('.container-section')?.parentElement;
          const articleComponent = root?.__vue__; const editorComponent = bodyElement.parentElement?.parentElement?.__vue__;
          try {
            if (typeof articleComponent?.setEditorContent === 'function') { articleComponent.setEditorContent(${JSON.stringify(html)}); articleComponent.content = ${JSON.stringify(html)}; editorApiWrote = true; }
            else if (typeof editorComponent?.setHTML === 'function') { editorComponent.setHTML(${JSON.stringify(html)}); editorApiWrote = true; }
          } catch {}
        }
        await pause(180);
        if (!readValues(bodyElement).some((value) => contentMatchesExpected(value, expectedBody))) bodyElement.innerHTML = ${JSON.stringify(html)};
        dispatchChanges(bodyElement, expectedBody, 'insertFromPaste');
      }
      await pause(350);
    }
    const actualTitle = normalize(isInput(titleElement) || isTextarea(titleElement) ? titleElement.value : titleElement?.textContent);
    const actualBodies = bodyCandidates.flatMap(({ element }) => readValues(element));
    const pageBodies = documents.map((current) => normalize(current.body?.innerText || current.body?.textContent || ''));
    const editorMatch = actualBodies.some((body) => contentMatchesExpected(body, expectedBody));
    const pageMatch = pageBodies.some((body) => contentMatchesExpected(body, expectedBody));
    const bodyVerificationSource = editorMatch ? 'editor' : pageMatch ? 'page' : 'none';
    const actualBody = [...actualBodies].sort((left, right) => right.length - left.length)[0] || '';
    return { titleFilled: actualTitle === normalize(${JSON.stringify(title)}), bodyFilled: bodyVerificationSource !== 'none', bodyVerificationSource, title: actualTitle, bodyTextLength: actualBody.length, editorFound: Boolean(titleElement && bodyElement), documentCount: documents.length, bodyCandidateCount: bodyCandidates.length };
  })()`;
}

export function buildSohuContentScriptForTest(title: string, html: string, write = false): string {
  return contentScript(title, html, write);
}

export async function ensureSohuEditor(webContents: WebContents, timeoutMs = 120_000): Promise<void> {
  if (!webContents.getURL().includes('/contentManagement/news/addarticle')) await webContents.loadURL(PUBLISH_URL);
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
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
    if (streak >= 3) return;
    await delay(700);
  }
  throw new Error('SOHU_EDITOR_NOT_READY: 搜狐号编辑器 120 秒内未就绪');
}

async function fillContent(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean; bodyVerificationSource: 'editor' | 'page' | 'none'; title: string; bodyTextLength: number }> {
  await webContents.executeJavaScript(contentScript(title, html, true));
  await delay(900);
  let result = await webContents.executeJavaScript(contentScript(title, html, false));
  for (let attempt = 0; attempt < 15 && (!result.titleFilled || !result.bodyFilled); attempt += 1) {
    await delay(600 + Math.min(attempt, 6) * 150);
    result = await webContents.executeJavaScript(contentScript(title, html, false));
  }
  return result;
}

async function applyOptionalSettings(webContents: WebContents): Promise<{ summaryClicked: boolean; summaryGenerated: boolean; summaryUnavailable: boolean; aiContentFound: boolean; aiContentSelected: boolean }> {
  const ai = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const text = [...document.querySelectorAll('label,[role="radio"],span,div')].filter(visible).find((element) => normalize(element.textContent) === '包含AI创作内容');
    const root = text?.closest('label,[role="radio"],.ant-radio-wrapper,.radio-item') || text?.parentElement;
    if (!(root instanceof HTMLElement)) return { found: false, selected: false, point: null };
    const input = root.querySelector('input[type="radio"]'); const selected = (input instanceof HTMLInputElement && input.checked) || root.getAttribute('aria-checked') === 'true' || /checked|selected|active/.test(String(root.className || ''));
    root.scrollIntoView({ block: 'center' }); const rect = root.getBoundingClientRect(); return { found: true, selected, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
  })()`);
  if (ai.found && !ai.selected && ai.point) {
    await delay(350);
    const currentAiPoint = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const text = [...document.querySelectorAll('label,[role="radio"],span,div')].filter(visible).find((element) => normalize(element.textContent) === '包含AI创作内容');
      const root = text?.closest('label,[role="radio"],.ant-radio-wrapper,.radio-item') || text?.parentElement;
      if (!(root instanceof HTMLElement)) return null; const rect = root.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (currentAiPoint) await clickPoint(webContents, currentAiPoint);
    await delay(900);
  }
  const aiContentSelected = ai.found ? await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const text = [...document.querySelectorAll('label,[role="radio"],span,div')].find((element) => normalize(element.textContent) === '包含AI创作内容');
    const root = text?.closest('label,[role="radio"],.ant-radio-wrapper,.radio-item') || text?.parentElement; const input = root?.querySelector('input[type="radio"]');
    return Boolean((input instanceof HTMLInputElement && input.checked) || root?.getAttribute('aria-checked') === 'true' || /checked|selected|active/.test(String(root?.className || '')));
  })()`) : false;
  return { summaryClicked: false, summaryGenerated: false, summaryUnavailable: false, aiContentFound: ai.found, aiContentSelected };
}

export async function fillSohuDraft(webContents: WebContents, title: string, html: string): Promise<SohuDraftFillResult> {
  await ensureSohuEditor(webContents);
  const content = await fillContent(webContents, title, html);
  if (!content.titleFilled || !content.bodyFilled) throw new Error(`SOHU_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  await delay(1_000);
  const beforeSettings = await webContents.executeJavaScript(contentScript(title, html, false));
  if (!beforeSettings.titleFilled || !beforeSettings.bodyFilled) throw new Error(`SOHU_CONTENT_NOT_STABLE_BEFORE_SETTINGS: title=${beforeSettings.titleFilled}, body=${beforeSettings.bodyFilled}`);
  const optional = await applyOptionalSettings(webContents);
  const stableContent = await webContents.executeJavaScript(contentScript(title, html, false));
  if (!stableContent.titleFilled || !stableContent.bodyFilled) throw new Error(`SOHU_CONTENT_NOT_STABLE: title=${stableContent.titleFilled}, body=${stableContent.bodyFilled}`);
  const finalState = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const publishButtonDetected = [...document.querySelectorAll('li.publish-report-btn,li[report-attr],button,[role="button"]')].filter(visible).some((element) => { const text = normalize(element.textContent); return text === '发布' && !text.includes('定时发布') && !element.hasAttribute('disabled'); });
    const ai = [...document.querySelectorAll('label,[role="radio"],span,div')].filter(visible).find((element) => normalize(element.textContent) === '包含AI创作内容'); if (ai instanceof HTMLElement) ai.scrollIntoView({ block: 'center' });
    return { publishButtonDetected, url: location.href };
  })()`);
  await delay(500);
  return { ...content, ...stableContent, ...optional, ...finalState };
}
