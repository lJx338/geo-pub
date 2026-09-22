import type { WebContents } from 'electron';
import { cdpClick, cdpInsertText, cdpKey } from './browser-automation-driver.js';
import { contentMatchesExpected } from './content-verification.js';

const PUBLISH_URL = 'https://om.qq.com/main/creation/article';
const TITLE_SELECTORS = ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '.article-title input', '.title input', '[contenteditable="true"][data-placeholder*="标题"]'];
const BODY_SELECTORS = ['.ql-editor', '.ProseMirror', '.DraftEditor-editorContainer [contenteditable="true"]', '.article-editor [contenteditable="true"]', '[role="textbox"]', '[contenteditable="true"]', 'textarea[placeholder*="正文"]', 'iframe'];

export interface PenguinDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  bodyVerificationSource: 'editor' | 'none';
  title: string;
  bodyTextLength: number;
  formatVerification: {
    expected: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    actual: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    preserved: boolean;
    degradedBlocks: string[];
  };
  formatWarnings?: string[];
  tagsRequested: string[];
  tagsApplied: string[];
  recommendedTagsDetected: boolean;
  aiDeclarationSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
}

/**
 * ProseMirror can alter its flattened innerText around list and quote wrappers.
 * Compare logical blocks when that happens, while requiring every block to be
 * present and equal. This is intentionally not a substring or sampled match.
 */
export function penguinBlockTextsMatch(actualBlocks: unknown[], expectedBlocks: unknown[]): boolean {
  const normalize = (value: unknown) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return actualBlocks.length === expectedBlocks.length
    && actualBlocks.length > 0
    && actualBlocks.every((block, index) => normalize(block) === normalize(expectedBlocks[index]));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function normalizePenguinTags(tags: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    for (const part of String(raw || '').split(/[\s,，;；、|]+/)) {
      const tag = part.replace(/^[#＃]+|[#＃]+$/g, '').trim();
      const key = tag.toLocaleLowerCase();
      if (!tag || Array.from(tag).length > 8 || seen.has(key)) continue;
      seen.add(key);
      result.push(tag);
      if (result.length === 9) return result;
    }
  }
  return result;
}

export async function ensurePenguinEditor(webContents: WebContents, timeoutMs = 120_000): Promise<void> {
  if (!/om\.qq\.com\/(?:main\/creation\/article|article\/articlePublish)/.test(webContents.getURL())) {
    await webContents.loadURL(PUBLISH_URL);
  }
  const deadline = Date.now() + timeoutMs;
  let readyStreak = 0;
  while (Date.now() < deadline) {
    const state = await webContents.executeJavaScript(`(() => {
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })();
      const title = ${JSON.stringify(TITLE_SELECTORS)}.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
      const body = ${JSON.stringify(BODY_SELECTORS)}.flatMap((selector) => [...document.querySelectorAll(selector)])
        .find((element) => element !== title && (element instanceof HTMLIFrameElement || visible(element)));
      const text = String(document.body?.innerText || '');
      return {
        ready: Boolean(title && body),
        loginBlocked: /扫码登录|请先登录|登录后继续|验证码|安全验证|验证身份|风险验证|账号异常|企鹅号登录|QQ登录|微信登录/.test(text)
          || /login|userAuth|passport|graph\.qq\.com/i.test(location.href),
      };
    })()`);
    if (state.loginBlocked) throw new Error('PENGUIN_LOGIN_REQUIRED: 请在桌面端完成企鹅号登录或验证');
    readyStreak = state.ready ? readyStreak + 1 : 0;
    if (readyStreak >= 3) return;
    await delay(700);
  }
  throw new Error('PENGUIN_EDITOR_NOT_READY: 企鹅号编辑器 120 秒内未就绪');
}

async function readContent(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean; bodyVerificationSource: 'editor' | 'none'; title: string; bodyTextLength: number; formatVerification: PenguinDraftFillResult['formatVerification'] }> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const contentMatchesExpected = ${contentMatchesExpected.toString()};
    const penguinBlockTextsMatch = ${penguinBlockTextsMatch.toString()};
    const holder = document.createElement('div'); holder.innerHTML = ${JSON.stringify(html)};
    const expected = normalize(holder.innerText || holder.textContent || '');
    const logicalBlocks = (root) => [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,hr')]
      .filter((element) => {
        if (element.matches('p') && element.closest('li,blockquote')) return false;
        return !element.parentElement?.closest('li,blockquote') || element.matches('li,blockquote');
      })
      .map((element) => normalize(element.innerText || element.textContent || ''));
    const expectedBlocks = logicalBlocks(holder);
    const countStructure = (root) => ({ headings: root.querySelectorAll('h2,h3').length, lists: root.querySelectorAll('ul,ol').length, quotes: root.querySelectorAll('blockquote').length, dividers: root.querySelectorAll('hr').length, images: root.querySelectorAll('img').length });
    const expectedStructure = countStructure(holder);
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const titleElement = ${JSON.stringify(TITLE_SELECTORS)}.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    const bodyTargets = [...new Set(${JSON.stringify(BODY_SELECTORS)}.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter((element) => element !== titleElement && (element instanceof HTMLIFrameElement || visible(element)))
      .map((element) => element instanceof HTMLIFrameElement ? element.contentDocument?.body : element).filter(Boolean);
    const actualTitle = normalize(titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement ? titleElement.value : titleElement?.textContent);
    const editorCandidates = bodyTargets.map((target) => ({
      target,
      body: normalize(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target?.innerText || target?.textContent),
    }));
    const matchingEditor = editorCandidates.find(({ body, target }) => contentMatchesExpected(body, expected)
      || penguinBlockTextsMatch(logicalBlocks(target), expectedBlocks));
    const editorMatch = Boolean(matchingEditor);
    const bodyVerificationSource = editorMatch ? 'editor' : 'none';
    const actualBody = matchingEditor?.body || '';
    const actualStructure = matchingEditor ? countStructure(matchingEditor.target) : { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 };
    const labels = { headings: '小标题', lists: '列表', quotes: '引用', dividers: '分隔线', images: '正文图片' };
    const degradedBlocks = Object.keys(expectedStructure).filter((key) => actualStructure[key] < expectedStructure[key]).map((key) => labels[key]);
    if (bodyVerificationSource !== 'editor' && degradedBlocks.length === 0 && Object.values(expectedStructure).some(Boolean)) degradedBlocks.push('编辑器结构无法确认');
    return { titleFilled: actualTitle === normalize(${JSON.stringify(title)}), bodyFilled: bodyVerificationSource !== 'none', bodyVerificationSource, title: actualTitle, bodyTextLength: actualBody.length, formatVerification: { expected: expectedStructure, actual: actualStructure, preserved: degradedBlocks.length === 0, degradedBlocks } };
  })()`);
}

async function fillContent(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean; bodyVerificationSource: 'editor' | 'none'; title: string; bodyTextLength: number; formatVerification: PenguinDraftFillResult['formatVerification'] }> {
  await webContents.executeJavaScript(`(() => {
    const requestedTitle=${JSON.stringify(title)};
    const visible=(element)=>element instanceof HTMLElement&&element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0;
    const titleElement=${JSON.stringify(TITLE_SELECTORS)}.flatMap((selector)=>[...document.querySelectorAll(selector)]).find(visible);
    const bodyElement=${JSON.stringify(BODY_SELECTORS)}.flatMap((selector)=>[...document.querySelectorAll(selector)])
      .find((element)=>element!==titleElement&&(element instanceof HTMLIFrameElement||visible(element)));
    if(titleElement instanceof HTMLInputElement||titleElement instanceof HTMLTextAreaElement){
      const prototype=titleElement instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value')?.set?.call(titleElement,requestedTitle);
      titleElement.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:requestedTitle}));
      titleElement.dispatchEvent(new Event('change',{bubbles:true}));
    }else if(titleElement instanceof HTMLElement){
      titleElement.replaceChildren(document.createTextNode(requestedTitle));
      titleElement.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:requestedTitle}));
    }
    const bodyTarget=bodyElement instanceof HTMLIFrameElement?bodyElement.contentDocument?.body:bodyElement;
    if(!(bodyTarget instanceof HTMLElement)||bodyTarget instanceof HTMLInputElement||bodyTarget instanceof HTMLTextAreaElement)return false;
    bodyTarget.scrollIntoView({block:'center',inline:'nearest'}); bodyTarget.focus({preventScroll:true});
    const range=bodyTarget.ownerDocument.createRange(); range.selectNodeContents(bodyTarget);
    const selection=bodyTarget.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return bodyTarget.ownerDocument.activeElement===bodyTarget&&selection?.rangeCount===1;
  })()`);
  await webContents.executeJavaScript(`(() => {
    const requestedTitle = ${JSON.stringify(title)}; const requestedHtml = ${JSON.stringify(html)};
    const holder = document.createElement('div'); holder.innerHTML = requestedHtml;
    const requestedText = String(holder.innerText || holder.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const titleElement = ${JSON.stringify(TITLE_SELECTORS)}.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    const bodyElement = ${JSON.stringify(BODY_SELECTORS)}.flatMap((selector) => [...document.querySelectorAll(selector)])
      .find((element) => element !== titleElement && (element instanceof HTMLIFrameElement || visible(element)));
    const setValue = (element, value) => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement) setValue(titleElement, requestedTitle);
    else if (titleElement instanceof HTMLElement) { titleElement.replaceChildren(document.createTextNode(requestedTitle)); titleElement.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    const bodyTarget = bodyElement instanceof HTMLIFrameElement ? bodyElement.contentDocument?.body : bodyElement;
    if (bodyTarget instanceof HTMLInputElement || bodyTarget instanceof HTMLTextAreaElement) setValue(bodyTarget, requestedText);
    else if (bodyTarget instanceof HTMLElement) {
      bodyTarget.focus(); const range = bodyTarget.ownerDocument.createRange(); range.selectNodeContents(bodyTarget);
      const selection = bodyTarget.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      if (!bodyTarget.ownerDocument.execCommand('insertHTML', false, requestedHtml)) bodyTarget.innerHTML = requestedHtml;
      bodyTarget.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: requestedText }));
      bodyTarget.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  let result = await readContent(webContents, title, html);
  if (result.titleFilled && !result.bodyFilled && await shouldRecoverProseMirror(webContents, html)) {
    const recovered = await recoverProseMirrorWithTrustedInput(webContents, html);
    if (recovered) result = await readContent(webContents, title, html);
  }
  for (let attempt = 0; attempt < 8 && (!result.titleFilled || !result.bodyFilled || !result.formatVerification.preserved); attempt += 1) {
    await delay(500 + attempt * 150);
    result = await readContent(webContents, title, html);
  }
  return result;
}

async function shouldRecoverProseMirror(webContents: WebContents, html: string): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const contentMatchesExpected = ${contentMatchesExpected.toString()};
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].find(visible);
    if (!(editor instanceof HTMLElement)) return false;
    const holder = document.createElement('div'); holder.innerHTML = ${JSON.stringify(html)};
    const expected = normalize(holder.innerText || holder.textContent || '');
    const actual = normalize(editor.innerText || editor.textContent || '');
    const blocked = /扫码登录|请先登录|登录后继续|验证码|安全验证|验证身份|风险验证|账号异常|登录失效/.test(normalize(document.body?.innerText));
    return !blocked && contentMatchesExpected(actual, expected);
  })()`);
}

async function recoverProseMirrorWithTrustedInput(webContents: WebContents, html: string): Promise<boolean> {
  const prepared = await webContents.executeJavaScript(`(() => {
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].find(visible);
    if (!(editor instanceof HTMLElement)) return { ready: false, blocks: [] };
    const holder = document.createElement('div'); holder.innerHTML = ${JSON.stringify(html)};
    const blocks = [...holder.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote')]
      .filter((element) => !(element.matches('p') && element.closest('li,blockquote')))
      .map((element) => String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor);
    const selection = editor.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return { ready: document.activeElement === editor, blocks };
  })()`);
  if (!prepared?.ready || !Array.isArray(prepared.blocks) || prepared.blocks.length === 0) return false;
  await cdpKey(webContents, 'Backspace', 'Backspace', 8);
  await delay(250);
  for (let index = 0; index < prepared.blocks.length; index += 1) {
    await cdpInsertText(webContents, String(prepared.blocks[index] || ''));
    if (index < prepared.blocks.length - 1) {
      await cdpKey(webContents, 'Enter', 'Enter', 13);
      await delay(80);
    }
  }
  await delay(1_000);
  return true;
}

async function applyTags(webContents: WebContents, rawTags: string[]): Promise<{ requested: string[]; applied: string[]; recommended: boolean }> {
  const tags = normalizePenguinTags(rawTags);
  const prepared = await webContents.executeJavaScript(`(async () => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    [...document.querySelectorAll('*')].filter((element) => element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 20).forEach((element) => { element.scrollTop = element.scrollHeight; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const recommended = normalize(document.body?.innerText).includes('推荐标签');
    const roots = [...document.querySelectorAll('.omui-suggestion__input.is--multi')].filter(visible);
    const root = roots.find((candidate) => normalize(candidate.textContent).includes('最多9个标签')) || roots.at(-1);
    const input = root?.querySelector('input.omui-suggestion__value,input,textarea');
    document.querySelectorAll('[data-geo-penguin-tag-input]').forEach((element) => element.removeAttribute('data-geo-penguin-tag-input'));
    if (input instanceof HTMLElement) input.setAttribute('data-geo-penguin-tag-input', 'true');
    const clearPoints = root instanceof HTMLElement ? [...root.querySelectorAll('.omui-suggestion__choseclear')]
      .filter(visible).map((element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }) : [];
    return { found: input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement, recommended, clearPoints };
  })()`);
  for (const point of [...(prepared.clearPoints || [])].reverse()) {
    await clickAt(webContents, point);
    await delay(300);
  }
  if (!prepared.found || tags.length === 0) return { requested: tags, applied: [], recommended: prepared.recommended };
  const applied: string[] = [];
  for (const tag of tags) {
    const focused = await webContents.executeJavaScript(`(() => {
      const input = document.querySelector('[data-geo-penguin-tag-input="true"]');
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      input.focus(); Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, ${JSON.stringify(tag)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(tag)} }));
      return document.activeElement === input;
    })()`);
    if (!focused) continue;
    await cdpKey(webContents, 'Enter', 'Enter', 13);
    let verified = false;
    for (let attempt = 0; attempt < 5 && !verified; attempt += 1) {
      await delay(250);
      verified = await tagIsSelected(webContents, tag);
    }
    if (!verified) {
      const candidate = await webContents.executeJavaScript(`(() => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
        const input = document.querySelector('[data-geo-penguin-tag-input="true"]');
        const root = input?.closest('.omui-suggestion__input.is--multi');
        const option = [...document.querySelectorAll('.omui-suggestion__option,[role="option"],li,button,div')]
          .filter((element) => element !== root && visible(element) && normalize(element.textContent) === ${JSON.stringify(tag)})
          .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
        if (!(option instanceof HTMLElement)) return null;
        const rect = option.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (candidate) {
        await clickAt(webContents, candidate);
        for (let attempt = 0; attempt < 5 && !verified; attempt += 1) {
          await delay(250);
          verified = await tagIsSelected(webContents, tag);
        }
      }
    }
    if (verified) applied.push(tag);
  }
  return { requested: tags, applied, recommended: prepared.recommended };
}

async function tagIsSelected(webContents: WebContents, tag: string): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const input = document.querySelector('[data-geo-penguin-tag-input="true"]');
      const root = input?.closest('.omui-suggestion__input.is--multi');
      if (!(root instanceof HTMLElement)) return false;
      return [...root.querySelectorAll('.omui-suggestion__chose')]
        .some((element) => normalize(element.textContent).replace(/[×x]$/i, '').trim() === ${JSON.stringify(tag)});
    })()`);
}

async function clickAt(webContents: WebContents, point: { x: number; y: number }): Promise<void> {
  await cdpClick(webContents, { x: Math.round(point.x), y: Math.round(point.y) });
}

async function ensureAiDeclaration(webContents: WebContents): Promise<boolean> {
  const finishOpenDialog = async (): Promise<boolean> => {
    const clicked = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none';
      const dialog = [...document.querySelectorAll('[role="dialog"],.omui-dialog,.omui-dialog-wrapper')]
        .filter(visible).find((element) => normalize(element.textContent).includes('发布内容自主声明')
          && normalize(element.textContent).includes('该文章由AI辅助创作'));
      if (!(dialog instanceof HTMLElement)) return false;
      const option = [...dialog.querySelectorAll('label.omui-radio,[role="radio"],.radio-item')]
        .find((element) => normalize(element.textContent) === '该文章由AI辅助创作');
      const input = option?.querySelector('input[type="radio"]');
      const selected = (input instanceof HTMLInputElement && input.checked)
        || option?.getAttribute('aria-checked') === 'true'
        || /checked|selected|active/.test(String(option?.className || ''));
      if (!selected) return false;
      const confirm = [...dialog.querySelectorAll('button,[role="button"]')]
        .find((element) => visible(element) && normalize(element.textContent) === '确认');
      if (!(confirm instanceof HTMLElement)) return false;
      confirm.click();
      return true;
    })()`);
    if (!clicked) return false;
    await delay(900);
    return await webContents.executeJavaScript(`(() => { const root = document.querySelector('#articlePublish-selfDeclaration'); return Boolean(root && String(root.textContent || '').replace(/\s+/g, '').includes('该文章由AI辅助创作')); })()`);
  };

  if (await finishOpenDialog()) return true;
  const entry = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    const root = document.querySelector('#articlePublish-selfDeclaration');
    if (root && normalize(root.textContent).includes('该文章由AI辅助创作')) return { selected: true, point: null };
    const target = [...document.querySelectorAll('button,[role="button"],label,span,div')].filter(visible)
      .filter((element) => /添加内容自主声明|作者声明：无需标注/.test(normalize(element.textContent)))
      .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
    if (!(target instanceof HTMLElement)) return { selected: false, point: null };
    target.scrollIntoView({ block: 'center', inline: 'nearest' }); const rect = target.getBoundingClientRect();
    return { selected: false, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
  })()`);
  if (entry.selected) return true;
  if (!entry.point) return false;
  await clickAt(webContents, entry.point); await delay(800);
  const option = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const target = [...document.querySelectorAll('label.omui-radio,[role="radio"],.radio-item')].filter(visible)
      .find((element) => normalize(element.textContent) === '该文章由AI辅助创作');
    if (!(target instanceof HTMLElement)) return null; const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!option) return false;
  await clickAt(webContents, option); await delay(500);
  return await finishOpenDialog();
}

export async function fillPenguinDraft(webContents: WebContents, title: string, html: string, tags: string[]): Promise<PenguinDraftFillResult> {
  await ensurePenguinEditor(webContents);
  const content = await fillContent(webContents, title, html);
  if (!content.titleFilled || !content.bodyFilled) throw new Error(`PENGUIN_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  const formatWarnings = content.formatVerification.preserved ? [] : [...content.formatVerification.degradedBlocks];
  const tagState = await applyTags(webContents, tags);
  const aiDeclarationSelected = await ensureAiDeclaration(webContents);
  const finalState = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const publishButtonDetected = [...document.querySelectorAll('button,[role="button"]')].filter(visible)
      .some((element) => ['发布', '提交审核', '发表'].includes(normalize(element.textContent)) && !element.hasAttribute('disabled'));
    const root = document.querySelector('#articlePublish-selfDeclaration'); if (root instanceof HTMLElement) root.scrollIntoView({ block: 'center' });
    return { publishButtonDetected, url: location.href };
  })()`);
  await delay(500);
  return { ...content, ...(formatWarnings.length ? { formatWarnings } : {}), tagsRequested: tagState.requested, tagsApplied: tagState.applied, recommendedTagsDetected: tagState.recommended, aiDeclarationSelected, ...finalState };
}
