import type { WebContents } from 'electron';

const PUBLISH_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1';

export interface SohuDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
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

function contentScript(title: string, html: string, write: boolean): string {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })();
    const meta = (element) => normalize([element?.getAttribute?.('placeholder'), element?.getAttribute?.('data-placeholder'), element?.getAttribute?.('aria-label'), element?.className].join(' '));
    const candidates = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
    const titleElement = candidates.map((element) => ({ element, score: (meta(element).includes('标题') ? 300 : 0) + (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? 80 : 0) }))
      .sort((left, right) => right.score - left.score)[0]?.element || null;
    const bodyElement = candidates.filter((element) => element !== titleElement).map((element) => ({ element, score: (meta(element).includes('正文') ? 300 : 0) + (meta(element).toLowerCase().includes('editor') ? 120 : 0) + (element.getBoundingClientRect().height > 160 ? 120 : 0) }))
      .sort((left, right) => right.score - left.score)[0]?.element || null;
    const holder = document.createElement('div'); holder.innerHTML = ${JSON.stringify(html)}; const expectedBody = normalize(holder.innerText || holder.textContent || '');
    const setValue = (element, value) => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value); element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value })); element.dispatchEvent(new Event('change', { bubbles: true })); };
    if (${write}) {
      if (titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement) setValue(titleElement, ${JSON.stringify(title)});
      else if (titleElement instanceof HTMLElement) { titleElement.replaceChildren(document.createTextNode(${JSON.stringify(title)})); titleElement.dispatchEvent(new InputEvent('input', { bubbles: true })); }
      if (bodyElement instanceof HTMLInputElement || bodyElement instanceof HTMLTextAreaElement) setValue(bodyElement, expectedBody);
      else if (bodyElement instanceof HTMLElement) { bodyElement.focus(); const range = document.createRange(); range.selectNodeContents(bodyElement); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); if (!document.execCommand('insertHTML', false, ${JSON.stringify(html)})) bodyElement.innerHTML = ${JSON.stringify(html)}; bodyElement.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: expectedBody })); bodyElement.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const actualTitle = normalize(titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement ? titleElement.value : titleElement?.textContent);
    const actualBody = normalize(bodyElement instanceof HTMLInputElement || bodyElement instanceof HTMLTextAreaElement ? bodyElement.value : bodyElement?.innerText || bodyElement?.textContent);
    const edge = Math.min(20, expectedBody.length);
    return { titleFilled: actualTitle === normalize(${JSON.stringify(title)}), bodyFilled: actualBody.includes(expectedBody.slice(0, edge)) && actualBody.includes(expectedBody.slice(-edge)), title: actualTitle, bodyTextLength: actualBody.length, editorFound: Boolean(titleElement && bodyElement) };
  })()`;
}

export async function ensureSohuEditor(webContents: WebContents, timeoutMs = 120_000): Promise<void> {
  if (!webContents.getURL().includes('/contentManagement/news/addarticle')) await webContents.loadURL(PUBLISH_URL);
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  while (Date.now() < deadline) {
    const state = await webContents.executeJavaScript(`(() => {
      const visible = (element) => element instanceof HTMLElement && (() => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })();
      const blocking = [...document.querySelectorAll('[role="dialog"],.tcaptcha-transform,.verify-box')].filter(visible)
        .some((element) => /验证码|安全验证|拖动下方滑块完成拼图|风险验证/.test(String(element.textContent || '')));
      const text = String(document.body?.innerText || '');
      const editables = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
      return { ready: editables.length >= 2 && !blocking, loginBlocked: /请登录后继续|登录后发布|扫码登录|重新登录/.test(text) || /login|passport/i.test(location.href), blocking };
    })()`);
    if (state.loginBlocked) throw new Error('SOHU_LOGIN_REQUIRED: 请在桌面端完成搜狐号登录');
    if (state.blocking) throw new Error('SOHU_VERIFICATION_REQUIRED: 搜狐号显示了可见验证码或安全验证');
    streak = state.ready ? streak + 1 : 0;
    if (streak >= 3) return;
    await delay(700);
  }
  throw new Error('SOHU_EDITOR_NOT_READY: 搜狐号编辑器 120 秒内未就绪');
}

async function fillContent(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean; title: string; bodyTextLength: number }> {
  await webContents.executeJavaScript(`(async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })();
    const titleElement = [...document.querySelectorAll('input[placeholder*="标题"],textarea[placeholder*="标题"]')].filter(visible)[0];
    const bodyElement = [...document.querySelectorAll('.ql-editor[contenteditable="true"],[contenteditable="true"][data-placeholder*="正文"]')].filter(visible)
      .sort((left, right) => right.getBoundingClientRect().height - left.getBoundingClientRect().height)[0];
    if (!(titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement) || !(bodyElement instanceof HTMLElement)) return false;
    titleElement.scrollIntoView({ block: 'center', inline: 'nearest' }); titleElement.focus({ preventScroll: true }); await pause(80);
    const prototype = titleElement instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(titleElement, ${JSON.stringify(title)});
    titleElement.dispatchEvent(new Event('input', { bubbles: true })); titleElement.dispatchEvent(new Event('change', { bubbles: true })); titleElement.dispatchEvent(new Event('blur', { bubbles: true }));
    await pause(240);
    bodyElement.scrollIntoView({ block: 'center', inline: 'nearest' });
    const articleRoot = bodyElement.closest('.article-container') || bodyElement.closest('.container-section')?.parentElement;
    const articleComponent = articleRoot?.__vue__;
    if (typeof articleComponent?.setEditorContent === 'function') {
      articleComponent.setEditorContent(${JSON.stringify(html)});
      articleComponent.content = ${JSON.stringify(html)};
      if (articleComponent.writtenContent && typeof articleComponent.writtenContent === 'object') {
        articleComponent.writtenContent.content = ${JSON.stringify(html)};
      }
    } else {
      const editorComponent = bodyElement.parentElement?.parentElement?.__vue__;
      if (typeof editorComponent?.setHTML !== 'function') return false;
      editorComponent.setHTML(${JSON.stringify(html)});
    }
    await pause(800);
    if (typeof articleComponent?.autoSaveContent === 'function') articleComponent.autoSaveContent();
    bodyElement.dispatchEvent(new Event('blur', { bubbles: true })); return true;
  })()`);
  await delay(1_200);
  let result = await webContents.executeJavaScript(contentScript(title, html, false));
  for (let attempt = 0; attempt < 8 && (!result.titleFilled || !result.bodyFilled); attempt += 1) {
    await delay(500 + attempt * 150);
    result = await webContents.executeJavaScript(contentScript(title, html, false));
  }
  return result;
}

async function applyOptionalSettings(webContents: WebContents): Promise<{ summaryClicked: boolean; summaryGenerated: boolean; summaryUnavailable: boolean; aiContentFound: boolean; aiContentSelected: boolean }> {
  const summaryClicked = false;
  const summaryGenerated = false;
  const summaryUnavailable = false;
  const ai = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
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
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const text = [...document.querySelectorAll('label,[role="radio"],span,div')].filter(visible).find((element) => normalize(element.textContent) === '包含AI创作内容');
      const root = text?.closest('label,[role="radio"],.ant-radio-wrapper,.radio-item') || text?.parentElement;
      if (!(root instanceof HTMLElement)) return null; const rect = root.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (currentAiPoint) await clickPoint(webContents, currentAiPoint);
    await delay(900);
  }
  const aiContentSelected = ai.found ? await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const text = [...document.querySelectorAll('label,[role="radio"],span,div')].find((element) => normalize(element.textContent) === '包含AI创作内容');
    const root = text?.closest('label,[role="radio"],.ant-radio-wrapper,.radio-item') || text?.parentElement; const input = root?.querySelector('input[type="radio"]');
    return Boolean((input instanceof HTMLInputElement && input.checked) || root?.getAttribute('aria-checked') === 'true' || /checked|selected|active/.test(String(root?.className || '')));
  })()`) : false;
  return { summaryClicked, summaryGenerated, summaryUnavailable, aiContentFound: ai.found, aiContentSelected };
}

export async function fillSohuDraft(webContents: WebContents, title: string, html: string): Promise<SohuDraftFillResult> {
  await ensureSohuEditor(webContents);
  const content = await fillContent(webContents, title, html);
  if (!content.titleFilled || !content.bodyFilled) throw new Error(`SOHU_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  await delay(1_000);
  const beforeSettings = await webContents.executeJavaScript(contentScript(title, html, false));
  if (!beforeSettings.titleFilled || !beforeSettings.bodyFilled) {
    throw new Error(`SOHU_CONTENT_NOT_STABLE_BEFORE_SETTINGS: title=${beforeSettings.titleFilled}, body=${beforeSettings.bodyFilled}`);
  }
  const optional = await applyOptionalSettings(webContents);
  const stableContent = await webContents.executeJavaScript(contentScript(title, html, false));
  if (!stableContent.titleFilled || !stableContent.bodyFilled) {
    throw new Error(`SOHU_CONTENT_NOT_STABLE: title=${stableContent.titleFilled}, body=${stableContent.bodyFilled}`);
  }
  const finalState = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim(); const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const publishButtonDetected = [...document.querySelectorAll('li.publish-report-btn,li[report-attr],button,[role="button"]')].filter(visible).some((element) => { const text = normalize(element.textContent); return text === '发布' && !text.includes('定时发布') && !element.hasAttribute('disabled'); });
    const ai = [...document.querySelectorAll('label,[role="radio"],span,div')].filter(visible).find((element) => normalize(element.textContent) === '包含AI创作内容'); if (ai instanceof HTMLElement) ai.scrollIntoView({ block: 'center' });
    return { publishButtonDetected, url: location.href };
  })()`);
  await delay(500);
  return { ...content, ...stableContent, ...optional, ...finalState };
}
