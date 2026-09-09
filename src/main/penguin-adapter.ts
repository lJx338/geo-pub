import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WebContents } from 'electron';
import { activeBrowserAutomationDriver, cdpClick, cdpKey } from './browser-automation-driver.js';
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
  coverUploaded: boolean;
  recommendedTagsDetected: boolean;
  aiDeclarationSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
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
    const editorCandidates = bodyTargets.map((target) => ({
      target,
      body: normalize(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target?.innerText || target?.textContent),
    }));
    const cacheCandidates = Object.keys(localStorage).filter((key) => key.startsWith('OM_ARTICLE_CACHE_')).map((key) => {
      try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return { key, body: normalize(value.content || '') }; } catch { return { key, body: '' }; }
    });
    const pageBody = normalize(document.body?.innerText || document.body?.textContent || '');
    const matchingEditor = editorCandidates.find(({ body }) => contentMatchesExpected(body, expected));
    const matchingCache = cacheCandidates.find(({ body }) => contentMatchesExpected(body, expected));
    const editorMatch = Boolean(matchingEditor);
    const cacheMatch = Boolean(matchingCache);
    const pageMatch = contentMatchesExpected(pageBody, expected);
    const bodyVerificationSource = editorMatch ? 'editor' : cacheMatch ? 'draft_cache' : pageMatch ? 'page' : 'none';
    const actualBody = matchingEditor?.body || matchingCache?.body || (pageMatch ? pageBody : '');
    const actualStructure = matchingEditor ? countStructure(matchingEditor.target) : { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 };
    const labels = { headings: '小标题', lists: '列表', quotes: '引用', dividers: '分隔线', images: '正文图片' };
    const degradedBlocks = Object.keys(expectedStructure).filter((key) => actualStructure[key] < expectedStructure[key]).map((key) => labels[key]);
    if (bodyVerificationSource !== 'editor' && degradedBlocks.length === 0 && Object.values(expectedStructure).some(Boolean)) degradedBlocks.push('编辑器结构无法确认');
    return { titleFilled: actualTitle === normalize(${JSON.stringify(title)}), bodyFilled: bodyVerificationSource !== 'none', bodyVerificationSource, title: actualTitle, bodyTextLength: actualBody.length, formatVerification: { expected: expectedStructure, actual: actualStructure, preserved: degradedBlocks.length === 0, degradedBlocks } };
  })()`);
}

async function fillContent(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean; bodyVerificationSource: 'editor' | 'draft_cache' | 'page' | 'none'; title: string; bodyTextLength: number; formatVerification: PenguinDraftFillResult['formatVerification'] }> {
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
  for (let attempt = 0; attempt < 8 && (!result.titleFilled || !result.bodyFilled || !result.formatVerification.preserved); attempt += 1) {
    await delay(500 + attempt * 150);
    result = await readContent(webContents, title, html);
  }
  return result;
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

async function penguinCoverApplied(webContents: WebContents, title: string): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const image = [...document.querySelectorAll('.articleCoverWrap-cls3i-ak .cover-container img,.articleCoverWrap-cls3i-ak img')]
      .find((element) => visible(element) && ['http:', 'https:', 'blob:', 'data:image/'].some((prefix) => String(element.currentSrc || element.src || '').toLowerCase().startsWith(prefix)));
    if (image) return true;
    return Object.keys(localStorage).filter((key) => key.startsWith('OM_ARTICLE_CACHE_')).some((key) => {
      try {
        const value = JSON.parse(localStorage.getItem(key) || '{}');
        if (normalize(value.title) !== normalize(${JSON.stringify(title)})) return false;
        const covers = typeof value.imgurl_ext === 'string' ? JSON.parse(value.imgurl_ext || '[]') : value.imgurl_ext;
        return Array.isArray(covers) && covers.length > 0;
      } catch { return false; }
    });
  })()`);
}

async function penguinBodyImageApplied(webContents: WebContents): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => [...document.querySelectorAll('.ProseMirror img')].some((element) => {
    const source = String(element.currentSrc || element.src || '');
    return element instanceof HTMLImageElement && element.getBoundingClientRect().width > 0 && ['http:', 'https:', 'blob:', 'data:image/'].some((prefix) => source.toLowerCase().startsWith(prefix));
  }))()`);
}

async function clickPenguinImageDialogAction(webContents: WebContents): Promise<boolean> {
  const point = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const dialogs = [...document.querySelectorAll('[role="dialog"],.omui-dialog,.omui-dialog-wrapper,[class*="modal"],[class*="Modal"]')].filter(visible);
    const labels = ['确定', '确认', '完成', '使用', '保存', '插入'];
    const inDialogs = dialogs.flatMap((dialog) => [...dialog.querySelectorAll('button,[role="button"],a,div,span')]);
    const allCandidates = [...document.querySelectorAll('button,[role="button"],a,div,span')];
    const button = [...inDialogs, ...allCandidates]
      .filter((element, index, list) => list.indexOf(element) === index)
      .filter((element) => visible(element) && labels.includes(normalize(element.textContent)) && !element.hasAttribute('disabled'))
      .sort((left, right) => left.getBoundingClientRect().width * left.getBoundingClientRect().height - right.getBoundingClientRect().width * right.getBoundingClientRect().height)[0];
    if (!(button instanceof HTMLElement)) return null;
    const rect = button.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) return false;
  await clickAt(webContents, point);
  return true;
}

async function insertPenguinBodyImage(webContents: WebContents, coverPath: string): Promise<boolean> {
  if (await penguinBodyImageApplied(webContents)) return true;
  await webContents.executeJavaScript(`(() => {
    document.querySelectorAll('input[type="file"]').forEach((element) => element.setAttribute('data-geo-file-before-image-dialog', 'true'));
  })()`);
  const point = await webContents.executeJavaScript(`(() => {
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const button = [...document.querySelectorAll('exeditor-toolbar-button[data-toolbar-item-of="imagePlugin"],button.exeditor-menu-basic-image')].find(visible);
    if (!(button instanceof HTMLElement)) return null;
    button.scrollIntoView({ block: 'center', inline: 'nearest' }); const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error('PENGUIN_BODY_IMAGE_BUTTON_NOT_FOUND: 未找到企鹅号正文图片按钮');
  const driver = activeBrowserAutomationDriver(webContents);
  if (!driver) throw new Error('PENGUIN_COVER_UPLOAD_FAILED: 浏览器上传驱动不可用');
  let chooserHandled = false;
  try {
    await driver.chooseFileAfterClick(async () => {
      const clicked = await webContents.executeJavaScript(`(() => {
        const button = document.querySelector('exeditor-toolbar-button[data-toolbar-item-of="imagePlugin"],button.exeditor-menu-basic-image');
        if (!(button instanceof HTMLElement)) return false;
        button.click(); return true;
      })()`);
      if (!clicked) await clickAt(webContents, point);
    }, resolve(coverPath), 4_000);
    chooserHandled = true;
  } catch {
    // Some Penguin builds open a custom upload dialog instead of a native file chooser.
  }

  // Current Penguin builds open a custom modal first, then expose the native
  // chooser only after the modal's "本地上传/上传图片" entry is clicked.
  if (!chooserHandled) {
    const uploadPoint = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement
        && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0;
      const candidates = [...document.querySelectorAll('button,[role="button"],div,span')]
        .filter(visible);
      const local = candidates.find((element) => normalize(element.textContent) === '本地上传');
      if (local instanceof HTMLElement) local.click();
      const entry = candidates.find((element) => ['上传图片', '选择图片'].includes(normalize(element.textContent)));
      if (!(entry instanceof HTMLElement)) return null;
      const rect = entry.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (uploadPoint) {
      try {
        await driver.chooseFileAfterClick(async () => await clickAt(webContents, uploadPoint), resolve(coverPath), 4_000);
        chooserHandled = true;
      } catch {
        // The modal may expose an input asynchronously instead of opening a chooser.
      }
    }
  }

  let selector = '';
  for (let attempt = 0; attempt < 30 && !selector && !chooserHandled; attempt += 1) {
    selector = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const uploadEntry = [...document.querySelectorAll('button,[role="button"],div,span')].filter(visible)
        .find((element) => ['本地上传', '上传图片', '选择图片'].includes(normalize(element.textContent)));
      if (uploadEntry instanceof HTMLElement) uploadEntry.click();
      const marker = 'data-geo-penguin-body-image-file';
      document.querySelectorAll('[' + marker + ']').forEach((element) => element.removeAttribute(marker));
      const inputs = [...document.querySelectorAll('input[type="file"]')]
        .filter((element) => /image|jpg|jpeg|png|webp/i.test(String(element.getAttribute('accept') || 'image')));
      const input = inputs.find((element) => !element.hasAttribute('data-geo-file-before-image-dialog')) || inputs.at(-1);
      if (!(input instanceof HTMLInputElement)) return '';
      input.setAttribute(marker, 'true'); return '[' + marker + '="true"]';
    })()`);
    if (!selector) await delay(400);
  }
  if (!chooserHandled && !selector) throw new Error('PENGUIN_BODY_IMAGE_INPUT_NOT_FOUND: 点击正文图片按钮后未捕获文件选择器');
  if (selector) await driver.setFileInput(selector, resolve(coverPath));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(500);
    if (await penguinBodyImageApplied(webContents)) return true;
    await clickPenguinImageDialogAction(webContents);
  }
  if (await penguinBodyImageApplied(webContents)) return true;
  throw new Error(`PENGUIN_BODY_IMAGE_NOT_INSERTED: 图片文件已提交但正文未出现图片（nativeChooser=${chooserHandled}，domInput=${Boolean(selector)}）`);
}

async function uploadPenguinCover(webContents: WebContents, title: string, coverPath: string): Promise<boolean> {
  const absolutePath = resolve(coverPath);
  await access(absolutePath);
  if (await penguinCoverApplied(webContents, title)) return true;
  if (!(await insertPenguinBodyImage(webContents, absolutePath))) return false;
  const point = await webContents.executeJavaScript(`(() => {
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const button = [...document.querySelectorAll('button.addCoverBtn-cls3gyHX,.articleCoverWrap-cls3i-ak button.omui-button--add')].find(visible);
    if (!(button instanceof HTMLElement)) return null;
    button.scrollIntoView({ block: 'center', inline: 'nearest' }); const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) return false;
  await clickAt(webContents, point);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(500);
    if (await penguinCoverApplied(webContents, title)) return true;
    const imagePoint = await webContents.executeJavaScript(`(() => {
      const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const editor = document.querySelector('.ProseMirror');
      const image = [...document.querySelectorAll('img')].filter(visible)
        .find((element) => !editor?.contains(element) && ['http:', 'https:', 'blob:', 'data:image/'].some((prefix) => String(element.currentSrc || element.src || '').toLowerCase().startsWith(prefix)));
      if (!(image instanceof HTMLImageElement)) return null;
      const rect = image.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (imagePoint) await clickAt(webContents, imagePoint);
    const confirmPoint = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const dialogs = [...document.querySelectorAll('[role="dialog"],.omui-dialog,.omui-dialog-wrapper,[class*="modal"],[class*="Modal"]')].filter(visible);
      const button = dialogs.flatMap((dialog) => [...dialog.querySelectorAll('button,[role="button"]')])
        .find((element) => visible(element) && ['确定', '完成', '使用', '保存'].includes(normalize(element.textContent)) && !element.hasAttribute('disabled'));
      if (!(button instanceof HTMLElement)) return null;
      const rect = button.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (confirmPoint) await clickAt(webContents, confirmPoint);
  }
  return await penguinCoverApplied(webContents, title);
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

export async function fillPenguinDraft(webContents: WebContents, title: string, html: string, coverPath: string, tags: string[]): Promise<PenguinDraftFillResult> {
  await ensurePenguinEditor(webContents);
  const content = await fillContent(webContents, title, html);
  if (!content.titleFilled || !content.bodyFilled) throw new Error(`PENGUIN_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  if (!content.formatVerification.preserved) throw new Error(`PENGUIN_FORMAT_DEGRADED: 企鹅号编辑器未保留${content.formatVerification.degradedBlocks.join('、')}`);
  const coverUploaded = await uploadPenguinCover(webContents, title, coverPath);
  if (!coverUploaded) throw new Error('PENGUIN_COVER_UPLOAD_FAILED: 企鹅号单图封面未能上传或确认');
  const tagState = await applyTags(webContents, tags);
  const aiDeclarationSelected = await ensureAiDeclaration(webContents);
  if (!aiDeclarationSelected) throw new Error('PENGUIN_AI_DECLARATION_REQUIRED: 未能选择“该文章由AI辅助创作”自主声明');
  const finalState = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const publishButtonDetected = [...document.querySelectorAll('button,[role="button"]')].filter(visible)
      .some((element) => ['发布', '提交审核', '发表'].includes(normalize(element.textContent)) && !element.hasAttribute('disabled'));
    const root = document.querySelector('#articlePublish-selfDeclaration'); if (root instanceof HTMLElement) root.scrollIntoView({ block: 'center' });
    return { publishButtonDetected, url: location.href };
  })()`);
  await delay(500);
  return { ...content, tagsRequested: tagState.requested, tagsApplied: tagState.applied, coverUploaded, recommendedTagsDetected: tagState.recommended, aiDeclarationSelected, ...finalState };
}
