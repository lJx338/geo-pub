import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WebContents } from 'electron';
import { resumeVisibleDraft } from './editor-draft.js';

const PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish';
const TITLE_SELECTOR = 'textarea[placeholder*="标题"],input[placeholder*="标题"]';
const BODY_SELECTOR = '.ProseMirror[contenteditable="true"],.ql-editor[contenteditable="true"],[data-editor="content"] [contenteditable="true"]';

export interface DraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  title: string;
  bodyTextLength: number;
  formatVerification: {
    expected: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    actual: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    preserved: boolean;
    degradedBlocks: string[];
  };
  coverUploaded: boolean;
  noAdsSelected: boolean | null;
  aiDeclarationSelected: boolean;
  draftSaveState: 'saved' | 'saving' | 'failed' | 'unknown';
  previewButtonDetected: boolean;
  url: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function collapseAssistant(webContents: WebContents): Promise<void> {
  await webContents.executeJavaScript(`(async () => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const header = [...document.querySelectorAll('body *')]
      .filter((element) => visible(element) && normalize(element.textContent) === '头条创作助手')
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      })[0];
    if (!(header instanceof HTMLElement)) return false;
    let panel = header;
    for (let depth = 0; depth < 8 && panel.parentElement; depth += 1) {
      const parent = panel.parentElement;
      const rect = parent.getBoundingClientRect();
      if (visible(parent) && rect.width >= 240 && rect.width < window.innerWidth * 0.8
        && normalize(parent.textContent).includes('创作助手')) panel = parent;
    }
    const panelRect = panel.getBoundingClientRect();
    const control = [...panel.querySelectorAll('button,[role="button"]')].filter(visible).find((element) => {
      const label = normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
      if (/收起|折叠|关闭|隐藏/.test(label)) return true;
      const rect = element.getBoundingClientRect();
      return rect.width <= 72 && rect.height <= 72 && rect.right >= panelRect.right - 96 && rect.top <= panelRect.top + 96;
    });
    if (!(control instanceof HTMLElement)) return false;
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 450));
    return true;
  })()`).catch(() => false);
}

async function ensureNoAds(webContents: WebContents): Promise<boolean | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const labels = [...document.querySelectorAll('label.article-ad-radio,label')]
        .filter((label) => normalize(label.textContent) === '不投放广告')
        .filter((label) => label.querySelector('input[type="radio"][value="2"]'));
      const label = labels[0];
      if (!(label instanceof HTMLElement)) return { found: false, selected: false, x: 0, y: 0 };
      const input = label.querySelector('input[type="radio"][value="2"]');
      const group = label.closest('[role="radiogroup"],.byte-radio-group,.article-ad-radio-group') || label.parentElement;
      const selectedLabels = group ? [...group.querySelectorAll('label')].filter((candidate) => Boolean(
        candidate.querySelector(':scope > span > .byte-radio-inner.checked')
        || candidate.classList.contains('checked')
        || candidate.getAttribute('aria-checked') === 'true'
      )) : [];
      const selected = selectedLabels.length === 1
        ? selectedLabels[0] === label
        : Boolean(input instanceof HTMLInputElement && input.checked
          && !group?.querySelector('input[type="radio"][value="3"]:checked'));
      label.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (!selected && input instanceof HTMLElement) input.click();
      const rect = label.getBoundingClientRect();
      return { found: true, selected, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!result.found) return null;
    if (result.selected) {
      await delay(700);
      const stable = await webContents.executeJavaScript(`(() => {
        const label = [...document.querySelectorAll('label.article-ad-radio,label')]
          .find((candidate) => String(candidate.textContent || '').replace(/\\s+/g, ' ').trim() === '不投放广告'
            && candidate.querySelector('input[type="radio"][value="2"]'));
        const input = label?.querySelector('input[type="radio"][value="2"]');
        return input instanceof HTMLInputElement && input.checked;
      })()`);
      if (stable) return true;
      continue;
    }
    webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(result.x), y: Math.round(result.y), button: 'left', clickCount: 1 });
    webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(result.x), y: Math.round(result.y), button: 'left', clickCount: 1 });
    await delay(500 + attempt * 250);
  }
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const label = [...document.querySelectorAll('label.article-ad-radio,label')]
      .find((candidate) => normalize(candidate.textContent) === '不投放广告'
        && candidate.querySelector('input[type="radio"][value="2"]'));
    if (!(label instanceof HTMLElement)) return false;
    const input = label.querySelector('input[type="radio"][value="2"]');
    const group = label.closest('[role="radiogroup"],.byte-radio-group,.article-ad-radio-group') || label.parentElement;
    const selectedLabels = group ? [...group.querySelectorAll('label')].filter((candidate) => Boolean(
      candidate.querySelector(':scope > span > .byte-radio-inner.checked')
      || candidate.classList.contains('checked')
      || candidate.getAttribute('aria-checked') === 'true'
    )) : [];
    return selectedLabels.length === 1
      ? selectedLabels[0] === label
      : Boolean(input instanceof HTMLInputElement && input.checked
        && !group?.querySelector('input[type="radio"][value="3"]:checked'));
  })()`);
}

async function ensureAiDeclaration(webContents: WebContents): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })();
      const label = [...document.querySelectorAll('label,[role="checkbox"]')]
        .filter(visible)
        .find((candidate) => normalize(candidate.textContent) === '引用AI');
      if (!(label instanceof HTMLElement)) return { found: false, selected: false };
      const forId = label.getAttribute('for');
      let checkbox = forId ? document.getElementById(forId) : label.querySelector('input[type="checkbox"]');
      let scope = label.parentElement;
      for (let depth = 0; !(checkbox instanceof HTMLInputElement) && scope && depth < 5; depth += 1) {
        const inputs = [...scope.querySelectorAll('input[type="checkbox"]')].filter(visible);
        if (inputs.length === 1) checkbox = inputs[0];
        scope = scope.parentElement;
      }
      const visualScope = checkbox instanceof HTMLElement
        ? checkbox.closest('label,[role="checkbox"],[class*="checkbox"]')
        : label.closest('[role="checkbox"],[class*="checkbox"]');
      const selected = checkbox instanceof HTMLInputElement
        ? checkbox.checked
        : label.getAttribute('aria-checked') === 'true'
          || visualScope?.getAttribute('aria-checked') === 'true'
          || Boolean(visualScope?.querySelector('.checked,[class*="checked"]'));
      if (!selected) {
        label.scrollIntoView({ block: 'center', inline: 'nearest' });
        if (checkbox instanceof HTMLElement) checkbox.click();
        else label.click();
      }
      return { found: true, selected };
    })()`);
    if (!result.found) return false;
    if (result.selected) {
      await delay(700);
      const stable = await webContents.executeJavaScript(`(() => {
        const label = [...document.querySelectorAll('label,[role="checkbox"]')]
          .find((candidate) => String(candidate.textContent || '').replace(/\\s+/g, '').trim() === '引用AI');
        const input = label?.querySelector('input[type="checkbox"]');
        return input instanceof HTMLInputElement && input.checked;
      })()`);
      if (stable) return true;
      continue;
    }
    await delay(500 + attempt * 250);
  }
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const label = [...document.querySelectorAll('label,[role="checkbox"]')]
      .filter(visible).find((candidate) => normalize(candidate.textContent) === '引用AI');
    if (!(label instanceof HTMLElement)) return false;
    const forId = label.getAttribute('for');
    let input = forId ? document.getElementById(forId) : label.querySelector('input[type="checkbox"]');
    let scope = label.parentElement;
    for (let depth = 0; !(input instanceof HTMLInputElement) && scope && depth < 5; depth += 1) {
      const inputs = [...scope.querySelectorAll('input[type="checkbox"]')].filter(visible);
      if (inputs.length === 1) input = inputs[0];
      scope = scope.parentElement;
    }
    const visualScope = input instanceof HTMLElement
      ? input.closest('label,[role="checkbox"],[class*="checkbox"]')
      : label.closest('[role="checkbox"],[class*="checkbox"]');
    return input instanceof HTMLInputElement
      ? input.checked
      : label.getAttribute('aria-checked') === 'true'
        || visualScope?.getAttribute('aria-checked') === 'true'
        || Boolean(visualScope?.querySelector('.checked,[class*="checked"]'));
  })()`);
}

async function hasCoverAsset(webContents: WebContents): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const single = [...document.querySelectorAll('label,[role="radio"],.byte-radio,.semi-radio')]
      .filter(visible).find((element) => normalize(element.textContent) === '单图');
    let root = single instanceof HTMLElement ? single.parentElement : null;
    for (let depth = 0; root && depth < 12; depth += 1) {
      const text = normalize(root.textContent);
      if (text.includes('展示封面') && text.includes('无封面')
        && (root.querySelector('.article-cover-add') || (text.includes('编辑') && text.includes('替换')))) break;
      root = root.parentElement;
    }
    if (!root) return false;
    const text = normalize(root.textContent);
    if (text.includes('编辑') && text.includes('替换')) return true;
    return [...root.querySelectorAll('img')].some((image) => {
      const source = String(image.currentSrc || image.src || '');
      return visible(image) && /^(https?:|blob:|data:image\\/)/i.test(source);
    });
  })()`);
}

async function setFileInput(webContents: WebContents, selector: string, filePath: string): Promise<void> {
  const debuggerApi = webContents.debugger;
  const attachedHere = !debuggerApi.isAttached();
  if (attachedHere) debuggerApi.attach('1.3');
  try {
    const documentNode = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } };
    const query = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector,
    }) as { nodeId: number };
    if (!query.nodeId) throw new Error('TOUTIAO_COVER_FILE_INPUT_NOT_FOUND');
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: query.nodeId });
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function confirmCoverDialog(webContents: WebContents): Promise<boolean> {
  const target = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .filter((element) => ['确定', '完成', '使用'].includes(normalize(element.textContent)));
    const button = buttons.find((element) => {
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
        const text = normalize(parent.textContent);
        if (text.includes('上传图片') && (text.includes('本地上传') || text.includes('已上传'))) return true;
      }
      return false;
    }) || buttons[0];
    if (!(button instanceof HTMLElement)) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!target) return false;
  webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 });
  await delay(700);
  return true;
}

async function uploadCover(webContents: WebContents, coverPath: string): Promise<boolean> {
  const absolutePath = resolve(coverPath);
  await access(absolutePath);
  if (await confirmCoverDialog(webContents)) {
    await delay(800);
  }
  try {
    if (await hasCoverAsset(webContents)) return true;
  } catch (error) {
    throw new Error(`inspect_initial: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await collapseAssistant(webContents);
  } catch (error) {
    throw new Error(`collapse_assistant: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const single = [...document.querySelectorAll('label,[role="radio"],.byte-radio,.semi-radio')]
      .find((element) => normalize(element.textContent) === '单图');
    if (single instanceof HTMLElement) single.click();
    return Boolean(single);
  })()`);
  } catch (error) {
    throw new Error(`select_single: ${error instanceof Error ? error.message : String(error)}`);
  }
  await delay(700);
  let opened: boolean;
  try {
    opened = await webContents.executeJavaScript(`(() => {
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const entry = [...document.querySelectorAll('.article-cover-add')].find(visible);
    if (!(entry instanceof HTMLElement)) return false;
    entry.scrollIntoView({ block: 'center', inline: 'center' });
    entry.click();
    return true;
  })()`);
  } catch (error) {
    throw new Error(`open_cover_dialog: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!opened) return false;
  let selector = '';
  for (let attempt = 0; attempt < 30 && !selector; attempt += 1) {
    try {
      selector = await webContents.executeJavaScript(`(() => {
      const marker = 'data-geo-desktop-cover-file';
      document.querySelectorAll('[' + marker + ']').forEach((element) => element.removeAttribute(marker));
      const inputs = [...document.querySelectorAll('input[type="file"]')].filter((input) => {
        const accept = String(input.getAttribute('accept') || '').toLowerCase();
        return !accept || accept.includes('image') || accept.includes('.jpg') || accept.includes('.png');
      });
      const target = inputs[0];
      if (!(target instanceof HTMLInputElement)) return '';
      target.setAttribute(marker, 'true');
      return '[' + marker + '="true"]';
    })()`);
    } catch (error) {
      throw new Error(`locate_file_input: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!selector) await delay(300);
  }
  if (!selector) return false;
  try {
    await setFileInput(webContents, selector, absolutePath);
  } catch (error) {
    throw new Error(`set_file_input: ${error instanceof Error ? error.message : String(error)}`);
  }
  await delay(1200);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const clicked = await confirmCoverDialog(webContents);
    if (clicked) await delay(900);
    if (await hasCoverAsset(webContents)) return true;
    await delay(700);
  }
  return await hasCoverAsset(webContents);
}

export async function ensureToutiaoEditor(webContents: WebContents, timeoutMs = 120_000): Promise<void> {
  if (!webContents.getURL().startsWith('https://mp.toutiao.com/')) {
    await webContents.loadURL(PUBLISH_URL);
  }
  const deadline = Date.now() + timeoutMs;
  let draftChecked = false;
  while (Date.now() < deadline) {
    if (!draftChecked) {
      draftChecked = true;
      if (await resumeVisibleDraft(webContents)) {
        await delay(800);
        continue;
      }
    }
    const ready = await webContents.executeJavaScript(`(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return visible(document.querySelector(${JSON.stringify(TITLE_SELECTOR)}))
        && visible(document.querySelector(${JSON.stringify(BODY_SELECTOR)}));
    })()`);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('TOUTIAO_EDITOR_NOT_READY: 请检查是否已登录头条号，或在桌面端完成验证码');
}

async function writeToutiaoContent(
  webContents: WebContents,
  title: string,
  html: string,
): Promise<Pick<DraftFillResult, 'titleFilled' | 'bodyFilled' | 'title' | 'bodyTextLength' | 'formatVerification' | 'url'>> {
  return await webContents.executeJavaScript(`(() => {
    const visible = (element) => element instanceof HTMLElement && (() => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })();
    const title = [...document.querySelectorAll(${JSON.stringify(TITLE_SELECTOR)})].find(visible);
    const body = [...document.querySelectorAll(${JSON.stringify(BODY_SELECTOR)})].find(visible);
    if (!(title instanceof HTMLInputElement || title instanceof HTMLTextAreaElement) || !(body instanceof HTMLElement)) {
      return { titleFilled: false, bodyFilled: false, title: '', bodyTextLength: 0, formatVerification: { expected: { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 }, actual: { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 }, preserved: false, degradedBlocks: ['编辑器'] }, url: location.href };
    }
    const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/[\\s\\u200b-\\u200d\\ufeff]/g, '');
    const requestedTitle = ${JSON.stringify(title)};
    const requestedHtml = ${JSON.stringify(html)};
    const parser = document.createElement('div');
    parser.innerHTML = requestedHtml;
    // Toutiao's editor normalizes imported h2/h3 blocks to its own h1 heading node.
    const countStructure = (root) => ({ headings: root.querySelectorAll('h1,h2,h3').length, lists: root.querySelectorAll('ul,ol').length, quotes: root.querySelectorAll('blockquote').length, dividers: root.querySelectorAll('hr').length, images: root.querySelectorAll('img').length });
    const expectedStructure = countStructure(parser);
    const expectedBody = normalize(parser.innerText || parser.textContent);
    const descriptor = Object.getOwnPropertyDescriptor(
      title instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    );
    descriptor?.set?.call(title, requestedTitle);
    title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: requestedTitle }));
    title.dispatchEvent(new Event('change', { bubbles: true }));

    body.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(body);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand('insertHTML', false, requestedHtml); } catch { inserted = false; }
    if (!inserted || compact(body.innerText || body.textContent) !== compact(expectedBody)) {
      body.replaceChildren();
      body.insertAdjacentHTML('afterbegin', requestedHtml);
    }
    body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: null }));
    body.dispatchEvent(new Event('change', { bubbles: true }));
    body.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    const actualTitle = normalize(title.value);
    const actualBody = normalize(body.innerText || body.textContent);
    const actualStructure = countStructure(body);
    const labels = { headings: '小标题', lists: '列表', quotes: '引用', dividers: '分隔线', images: '正文图片' };
    const degradedBlocks = Object.keys(expectedStructure).filter((key) => actualStructure[key] < expectedStructure[key]).map((key) => labels[key]);
    return {
      titleFilled: actualTitle === normalize(requestedTitle),
      bodyFilled: compact(expectedBody).length > 0 && compact(actualBody) === compact(expectedBody),
      title: actualTitle,
      bodyTextLength: actualBody.length,
      formatVerification: { expected: expectedStructure, actual: actualStructure, preserved: degradedBlocks.length === 0, degradedBlocks },
      url: location.href,
    };
  })()`);
}

async function verifyToutiaoContent(
  webContents: WebContents,
  title: string,
  html: string,
): Promise<Pick<DraftFillResult, 'titleFilled' | 'bodyFilled' | 'title' | 'bodyTextLength' | 'formatVerification' | 'url'>> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/[\\s\\u200b-\\u200d\\ufeff]/g, '');
    const parser = document.createElement('div'); parser.innerHTML = ${JSON.stringify(html)};
    const expectedBody = normalize(parser.innerText || parser.textContent);
    const countStructure = (root) => ({ headings: root.querySelectorAll('h1,h2,h3').length, lists: root.querySelectorAll('ul,ol').length, quotes: root.querySelectorAll('blockquote').length, dividers: root.querySelectorAll('hr').length, images: root.querySelectorAll('img').length });
    const expectedStructure = countStructure(parser);
    const visible = (element) => element instanceof HTMLElement && (() => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })();
    const title = [...document.querySelectorAll(${JSON.stringify(TITLE_SELECTOR)})].find(visible);
    const body = [...document.querySelectorAll(${JSON.stringify(BODY_SELECTOR)})].find(visible);
    const actualTitle = title instanceof HTMLInputElement || title instanceof HTMLTextAreaElement ? normalize(title.value) : '';
    const actualBody = body instanceof HTMLElement ? normalize(body.innerText || body.textContent) : '';
    const actualStructure = body instanceof HTMLElement ? countStructure(body) : { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 };
    const labels = { headings: '小标题', lists: '列表', quotes: '引用', dividers: '分隔线', images: '正文图片' };
    const degradedBlocks = Object.keys(expectedStructure).filter((key) => actualStructure[key] < expectedStructure[key]).map((key) => labels[key]);
    return {
      titleFilled: actualTitle === normalize(${JSON.stringify(title)}),
      bodyFilled: compact(expectedBody).length > 0 && compact(actualBody) === compact(expectedBody),
      title: actualTitle,
      bodyTextLength: actualBody.length,
      formatVerification: { expected: expectedStructure, actual: actualStructure, preserved: degradedBlocks.length === 0, degradedBlocks },
      url: location.href,
    };
  })()`);
}

export async function fillToutiaoDraft(
  webContents: WebContents,
  title: string,
  html: string,
  coverPath: string,
): Promise<DraftFillResult> {
  await ensureToutiaoEditor(webContents);
  let result = await writeToutiaoContent(webContents, title, html);
  await delay(1_200);
  result = await verifyToutiaoContent(webContents, title, html);
  if (!result.titleFilled || !result.bodyFilled) {
    throw new Error(`TOUTIAO_CONTENT_FILL_FAILED: title=${result.titleFilled}, body=${result.bodyFilled}, actualLength=${result.bodyTextLength}`);
  }
  if (!result.formatVerification.preserved) throw new Error(`TOUTIAO_FORMAT_DEGRADED: 头条号编辑器未保留${result.formatVerification.degradedBlocks.join('、')}`);
  let noAdsSelected: boolean | null;
  try {
    noAdsSelected = await ensureNoAds(webContents);
  } catch (error) {
    throw new Error(`TOUTIAO_NO_ADS_STAGE: ${error instanceof Error ? error.message : String(error)}`);
  }
  let aiDeclarationSelected: boolean;
  try {
    aiDeclarationSelected = await ensureAiDeclaration(webContents);
  } catch (error) {
    throw new Error(`TOUTIAO_AI_DECLARATION_STAGE: ${error instanceof Error ? error.message : String(error)}`);
  }
  let coverUploaded: boolean;
  try {
    coverUploaded = await uploadCover(webContents, coverPath);
  } catch (error) {
    throw new Error(`TOUTIAO_COVER_STAGE: ${error instanceof Error ? error.message : String(error)}`);
  }
  await delay(1200);
  const finalNoAdsSelected = await ensureNoAds(webContents);
  const finalAiDeclarationSelected = await ensureAiDeclaration(webContents);
  let draftSaveState: DraftFillResult['draftSaveState'] = 'unknown';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    draftSaveState = await webContents.executeJavaScript(`(() => { const text=String(document.body?.innerText||'').replace(/\\s+/g,' '); if(/保存失败/.test(text))return 'failed'; if(/(?:草稿)?已保存|保存成功/.test(text))return 'saved'; if(/保存中|正在保存/.test(text))return 'saving'; return 'unknown'; })()`);
    if (draftSaveState === 'saved' || draftSaveState === 'failed') break;
    await delay(500);
  }
  let stableContent = await verifyToutiaoContent(webContents, title, html);
  for (let attempt = 0; (!stableContent.titleFilled || !stableContent.bodyFilled || !stableContent.formatVerification.preserved) && attempt < 2; attempt += 1) {
    await writeToutiaoContent(webContents, title, html);
    await delay(1_500 + attempt * 500);
    stableContent = await verifyToutiaoContent(webContents, title, html);
  }
  if (!stableContent.titleFilled || !stableContent.bodyFilled) {
    throw new Error(`TOUTIAO_CONTENT_NOT_STABLE: title=${stableContent.titleFilled}, body=${stableContent.bodyFilled}, actualLength=${stableContent.bodyTextLength}`);
  }
  if (!stableContent.formatVerification.preserved) throw new Error(`TOUTIAO_FORMAT_DEGRADED: 头条号编辑器未保留${stableContent.formatVerification.degradedBlocks.join('、')}`);
  const finalState = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    return {
      previewButtonDetected: [...document.querySelectorAll('button,[role="button"]')]
        .some((element) => normalize(element.textContent).includes('预览并发布')),
      url: location.href,
    };
  })()`);
  await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
    const label = [...document.querySelectorAll('label')]
      .find((candidate) => normalize(candidate.textContent) === '引用AI');
    if (label instanceof HTMLElement) label.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(label);
  })()`);
  await delay(500);
  return {
    ...stableContent,
    coverUploaded,
    noAdsSelected: finalNoAdsSelected ?? noAdsSelected,
    aiDeclarationSelected: finalAiDeclarationSelected || aiDeclarationSelected,
    draftSaveState,
    previewButtonDetected: finalState.previewButtonDetected,
    url: finalState.url,
  } as DraftFillResult;
}
