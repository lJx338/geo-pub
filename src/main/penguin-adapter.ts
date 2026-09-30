import type { WebContents } from 'electron';
import { contentMatchesExpected } from './content-verification.js';

const PUBLISH_URL = 'https://om.qq.com/main/creation/article';
const TITLE_SELECTORS = ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '.article-title input', '.title input', '[contenteditable="true"][data-placeholder*="标题"]'];
const BODY_SELECTORS = ['.ql-editor', '.ProseMirror', '.DraftEditor-editorContainer [contenteditable="true"]', '.article-editor [contenteditable="true"]', '[role="textbox"]', '[contenteditable="true"]', 'textarea[placeholder*="正文"]', 'iframe'];

export interface PenguinDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  bodyVerificationSource: 'editor' | 'draft_cache' | 'page' | 'none';
  title: string;
  bodyTextLength: number;
  formatVerification: {
    expected: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    actual: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    preserved: boolean;
    degradedBlocks: string[];
  };
  tagsRequested: string[];
  tagsApplied: string[];
  recommendedTagsDetected: boolean;
  aiDeclarationSelected: boolean;
  declarationMode: 'ai_assisted' | 'none';
  publishButtonDetected: boolean;
  url: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function normalizeTags(tags: string[]): string[] {
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

async function readContent(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean; bodyVerificationSource: 'editor' | 'draft_cache' | 'page' | 'none'; title: string; bodyTextLength: number; formatVerification: PenguinDraftFillResult['formatVerification'] }> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const contentMatchesExpected = ${contentMatchesExpected.toString()};
    const holder = document.createElement('div'); holder.innerHTML = ${JSON.stringify(html)};
    const expected = normalize(holder.innerText || holder.textContent || '');
    const countStructure = (root) => ({ headings: root.querySelectorAll('h2,h3').length, lists: root.querySelectorAll('ul,ol').length, quotes: root.querySelectorAll('blockquote').length, dividers: root.querySelectorAll('hr').length, images: root.querySelectorAll('img').length });
    const expectedStructure = countStructure(holder);
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const titleElement = ${JSON.stringify(TITLE_SELECTORS)}.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    const bodyTargets = [...new Set(${JSON.stringify(BODY_SELECTORS)}.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter((element) => element !== titleElement && (element instanceof HTMLIFrameElement || visible(element)))
      .map((element) => element instanceof HTMLIFrameElement ? element.contentDocument?.body : element).filter(Boolean);
    const actualTitle = normalize(titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement ? titleElement.value : titleElement?.textContent);
    const bodies = bodyTargets.map((target) => normalize(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target?.innerText || target?.textContent));
    const cacheBodies = Object.keys(localStorage).filter((key) => key.startsWith('OM_ARTICLE_CACHE_')).map((key) => {
      try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return normalize(value.content || ''); } catch { return ''; }
    });
    const pageBody = normalize(document.body?.innerText || document.body?.textContent || '');
    const editorMatch = bodies.some((body) => contentMatchesExpected(body, expected));
    const cacheMatch = cacheBodies.some((body) => contentMatchesExpected(body, expected));
    const pageMatch = contentMatchesExpected(pageBody, expected);
    const bodyVerificationSource = editorMatch ? 'editor' : cacheMatch ? 'draft_cache' : pageMatch ? 'page' : 'none';
    const actualBody = [...bodies, ...cacheBodies].sort((left, right) => right.length - left.length)[0] || '';
    const actualStructure = bodyTargets.map((target) => countStructure(target)).sort((left, right) => (right.headings + right.lists + right.quotes + right.dividers + right.images) - (left.headings + left.lists + left.quotes + left.dividers + left.images))[0] || { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 };
    const labels = { headings: '小标题', lists: '列表', quotes: '引用', dividers: '分隔线', images: '正文图片' };
    const degradedBlocks = Object.keys(expectedStructure).filter((key) => actualStructure[key] < expectedStructure[key]).map((key) => labels[key]);
    if (bodyVerificationSource !== 'editor' && degradedBlocks.length === 0 && Object.values(expectedStructure).some(Boolean)) degradedBlocks.push('编辑器结构无法确认');
    return { titleFilled: actualTitle === normalize(${JSON.stringify(title)}), bodyFilled: bodyVerificationSource !== 'none', bodyVerificationSource, title: actualTitle, bodyTextLength: actualBody.length, formatVerification: { expected: expectedStructure, actual: actualStructure, preserved: degradedBlocks.length === 0, degradedBlocks } };
  })()`);
}

async function fillContent(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean; bodyVerificationSource: 'editor' | 'draft_cache' | 'page' | 'none'; title: string; bodyTextLength: number; formatVerification: PenguinDraftFillResult['formatVerification'] }> {
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
  for (let attempt = 0; attempt < 8 && (!result.titleFilled || !result.bodyFilled || !result.formatVerification.preserved); attempt += 1) {
    await delay(500 + attempt * 150);
    result = await readContent(webContents, title, html);
  }
  return result;
}

async function applyTags(webContents: WebContents, rawTags: string[]): Promise<{ requested: string[]; applied: string[]; recommended: boolean }> {
  const tags = normalizeTags(rawTags);
  const prepared = await webContents.executeJavaScript(`(async () => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    [...document.querySelectorAll('*')].filter((element) => element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 20).forEach((element) => { element.scrollTop = element.scrollHeight; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const recommended = normalize(document.body?.innerText).includes('推荐标签');
    const inputs = [...document.querySelectorAll('.omui-suggestion__input input.omui-suggestion__value,.omui-suggestion__input input,input[placeholder*="标签"],textarea[placeholder*="标签"]')].filter(visible);
    const input = inputs.find((candidate) => {
      let owner = candidate.parentElement;
      for (let depth = 0; owner && depth < 7; depth += 1, owner = owner.parentElement) {
        if (normalize(owner.textContent).includes('最多9个标签')) return true;
      }
      return false;
    }) || inputs.at(-1);
    document.querySelectorAll('[data-geo-penguin-tag-input]').forEach((element) => element.removeAttribute('data-geo-penguin-tag-input'));
    if (input instanceof HTMLElement) input.setAttribute('data-geo-penguin-tag-input', 'true');
    const owner = input?.closest('.omui-suggestion__input');
    const clearPoints = owner instanceof HTMLElement ? [...owner.querySelectorAll('.omui-suggestion__choseclear')]
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
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    await delay(600);
    const verified = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const input = document.querySelector('[data-geo-penguin-tag-input="true"]');
      const owner = input?.closest('.omui-suggestion') || input?.parentElement?.parentElement;
      if (!(owner instanceof HTMLElement)) return false;
      return [...owner.querySelectorAll('span,li,button,[class*="tag"],[class*="Tag"]')]
        .some((element) => normalize(element.textContent) === ${JSON.stringify(tag)});
    })()`);
    if (verified) applied.push(tag);
  }
  return { requested: tags, applied, recommended: prepared.recommended };
}

async function clickAt(webContents: WebContents, point: { x: number; y: number }): Promise<void> {
  webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
}

async function selectPenguinDeclaration(webContents: WebContents, declarationText: string): Promise<boolean> {
  const declarationLiteral = JSON.stringify(declarationText);
  const readAppliedState = async (): Promise<boolean> => await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const root = document.querySelector('#articlePublish-selfDeclaration');
    if (root instanceof HTMLElement && normalize(root.textContent).includes(${declarationLiteral})) return true;
    // The editor has changed the wrapper markup several times. Once the
    // dialog is closed, accept a checked radio/custom radio whose label is
    // the requested declaration even when the stable id is absent.
    return [...document.querySelectorAll('input[type="radio"],[role="radio"],[aria-checked="true"]')]
      .some((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const owner = element.closest('label,li,div') || element;
        return normalize(owner.textContent).includes(${declarationLiteral})
          && (element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true');
      });
  })()`);

  const finishOpenDialog = async (): Promise<boolean> => {
    const optionClicked = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none'
        && getComputedStyle(element).visibility !== 'hidden';
      const dialog = [...document.querySelectorAll('body *')]
        .filter(visible)
        .filter((element) => normalize(element.textContent).includes('发布内容自主声明')
          && normalize(element.textContent).includes(${declarationLiteral}))
        .filter((element) => [...element.querySelectorAll('button,[role="button"]')]
          .some((button) => visible(button) && ['确认', '确定', '保存'].includes(normalize(button.textContent))))
        .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height
          - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
      if (!(dialog instanceof HTMLElement)) return false;
      const option = [...dialog.querySelectorAll('label,[role="radio"],input[type="radio"],button,span,div')]
        .filter(visible)
        .filter((element) => normalize(element.textContent) === ${declarationLiteral}
          || (element instanceof HTMLInputElement && normalize(element.parentElement?.textContent) === ${declarationLiteral}))
        .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height
          - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
      if (!(option instanceof HTMLElement)) return false;
      const input = option instanceof HTMLInputElement ? option : option.querySelector('input[type="radio"]')
        || option.closest('label')?.querySelector('input[type="radio"]');
      if (input instanceof HTMLInputElement) {
        input.click();
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else option.click();
      return true;
    })()`);
    if (!optionClicked) return false;
    await delay(300);
    const confirmed = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none'
        && getComputedStyle(element).visibility !== 'hidden';
      const dialog = [...document.querySelectorAll('body *')]
        .filter(visible)
        .filter((element) => normalize(element.textContent).includes('发布内容自主声明')
          && normalize(element.textContent).includes(${declarationLiteral}))
        .filter((element) => [...element.querySelectorAll('button,[role="button"]')]
          .some((button) => visible(button) && ['确认', '确定', '保存'].includes(normalize(button.textContent))))
        .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height
          - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
      if (!(dialog instanceof HTMLElement)) return false;
      const option = [...dialog.querySelectorAll('label,[role="radio"],input[type="radio"],button,span,div')]
        .filter(visible)
        .filter((element) => normalize(element.textContent) === ${declarationLiteral}
          || (element instanceof HTMLInputElement && normalize(element.parentElement?.textContent) === ${declarationLiteral}))
        .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height
          - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
      if (!(option instanceof HTMLElement)) return false;
      const input = option instanceof HTMLInputElement ? option : option.querySelector('input[type="radio"]')
        || option.closest('label')?.querySelector('input[type="radio"]');
      const owner = input instanceof HTMLInputElement ? input.closest('label,li,div') : option;
      const selected = (input instanceof HTMLInputElement && input.checked)
        || owner?.getAttribute('aria-checked') === 'true'
        || /checked|selected|active/.test(String(owner?.className || ''));
      if (!selected) return false;
      const confirm = [...dialog.querySelectorAll('button,[role="button"]')]
        .filter(visible).find((element) => ['确认', '确定', '保存'].includes(normalize(element.textContent)));
      if (!(confirm instanceof HTMLElement)) return false;
      confirm.click();
      return true;
    })()`);
    if (!confirmed) return false;
    await delay(900);
    return await readAppliedState();
  };

  if (await readAppliedState()) return true;
  if (await finishOpenDialog()) return true;
  const entry = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    const root = document.querySelector('#articlePublish-selfDeclaration');
    if (root && normalize(root.textContent).includes(${declarationLiteral})) return { selected: true, point: null };
    const target = [...document.querySelectorAll('button,[role="button"],label,span,div')].filter(visible)
      .filter((element) => /添加内容自主声明|作者声明：无需标注|该文章由AI辅助创作/.test(normalize(element.textContent)))
      .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
    if (!(target instanceof HTMLElement)) return { selected: false, point: null };
    target.scrollIntoView({ block: 'center', inline: 'nearest' }); const rect = target.getBoundingClientRect();
    return { selected: false, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
  })()`);
  if (entry.selected) return true;
  if (!entry.point) return false;
  await clickAt(webContents, entry.point); await delay(800);
  await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0
      && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none';
    const target = [...document.querySelectorAll('body *')].filter(visible)
      .filter((element) => normalize(element.textContent) === ${declarationLiteral})
      .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height
        - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
    if (!(target instanceof HTMLElement)) return false;
    const input = target.querySelector('input[type="radio"]') || target.closest('label')?.querySelector('input[type="radio"]');
    if (input instanceof HTMLInputElement) {
      input.click();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else target.click();
    return true;
  })()`);
  await delay(500);
  return await finishOpenDialog();
}

async function ensurePenguinDeclaration(webContents: WebContents): Promise<{ aiDeclarationSelected: boolean; declarationMode: 'ai_assisted' | 'none' }> {
  if (await selectPenguinDeclaration(webContents, '该文章由AI辅助创作')) {
    return { aiDeclarationSelected: true, declarationMode: 'ai_assisted' };
  }
  if (await selectPenguinDeclaration(webContents, '无需标注')) {
    return { aiDeclarationSelected: false, declarationMode: 'none' };
  }
  throw new Error('PENGUIN_DECLARATION_NOT_APPLIED: AI辅助创作和无需标注均未能选择');
}

export async function fillPenguinDraft(webContents: WebContents, title: string, html: string, tags: string[]): Promise<PenguinDraftFillResult> {
  await ensurePenguinEditor(webContents);
  const content = await fillContent(webContents, title, html);
  if (!content.titleFilled || !content.bodyFilled) throw new Error(`PENGUIN_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  if (!content.formatVerification.preserved) throw new Error(`PENGUIN_FORMAT_DEGRADED: 企鹅号编辑器未保留${content.formatVerification.degradedBlocks.join('、')}`);
  const tagState = await applyTags(webContents, tags);
  const declaration = await ensurePenguinDeclaration(webContents);
  const finalState = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const publishButtonDetected = [...document.querySelectorAll('button,[role="button"]')].filter(visible)
      .some((element) => ['发布', '提交审核', '发表'].includes(normalize(element.textContent)) && !element.hasAttribute('disabled'));
    const root = document.querySelector('#articlePublish-selfDeclaration'); if (root instanceof HTMLElement) root.scrollIntoView({ block: 'center' });
    return { publishButtonDetected, url: location.href };
  })()`);
  await delay(500);
  return { ...content, tagsRequested: tagState.requested, tagsApplied: tagState.applied, recommendedTagsDetected: tagState.recommended, ...declaration, ...finalState };
}
