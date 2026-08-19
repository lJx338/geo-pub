import type { WebContents } from 'electron';

const PUBLISH_URL = 'https://zhuanlan.zhihu.com/write';
const TITLE_SELECTOR = 'textarea[placeholder*="请输入标题"]';
const BODY_SELECTOR = '.public-DraftEditor-content[contenteditable="true"][role="textbox"],.public-DraftEditor-content[contenteditable="true"]';

export interface ZhihuDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  title: string;
  bodyTextLength: number;
  bodyExpectedLength: number;
  draftWordCount: number;
  draftStateVerified: boolean;
  formatVerification: FormatVerification;
  publishSettingsOpened: boolean;
  aiDeclarationFound: boolean;
  aiDeclarationSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
}

type FormatVerification = {
  expected: FormatCounts;
  actual: FormatCounts;
  preserved: boolean;
  degradedBlocks: string[];
};

type FormatCounts = { headings: number; lists: number; quotes: number; dividers: number; images: number };
type ZhihuInputBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string; level: 2 | 3 }
  | { type: 'list'; items: string[]; ordered: boolean }
  | { type: 'quote'; text: string }
  | { type: 'divider' };

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function clickEditorControl(webContents: WebContents, labels: string[], scope: 'toolbar' | 'menu' = 'toolbar'): Promise<boolean> {
  const point = await webContents.executeJavaScript(`(() => {
    const labels = ${JSON.stringify(labels)};
    const normalize = (value) => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    })();
    const menuOnly = ${JSON.stringify(scope)} === 'menu';
    const candidates = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],li,div,span')]
      .filter(visible).map((element) => ({ element, text: normalize(element.textContent), rect: element.getBoundingClientRect() }))
      .filter(({ element, text }) => labels.includes(text)
        && (!menuOnly || Boolean(element.closest('[role="menu"],[role="listbox"],[class*="Menu"],[class*="menu"],[class*="Popover"],[class*="popover"]'))))
      .sort((left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height);
    const target = candidates[0];
    if (!target) return null;
    target.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = target.element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) return false;
  webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
  webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
  await delay(350);
  return true;
}

async function setHeadingLevel(webContents: WebContents, level: 2 | 3): Promise<boolean> {
  if (!await clickEditorControl(webContents, ['标题'])) return false;
  const labels = level === 2
    ? ['二级标题', '标题 2', '标题2', 'H2', '标题二']
    : ['三级标题', '标题 3', '标题3', 'H3', '标题三'];
  return await clickEditorControl(webContents, labels, 'menu');
}

async function setListStyle(webContents: WebContents, ordered: boolean): Promise<boolean> {
  if (!await clickEditorControl(webContents, ['列表'])) return false;
  return await clickEditorControl(webContents, ordered ? ['有序列表', '编号列表'] : ['无序列表', '项目列表'], 'menu');
}

async function closeFormattingMenu(webContents: WebContents): Promise<void> {
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await delay(120);
}

export async function ensureZhihuEditor(webContents: WebContents, timeoutMs = 120_000): Promise<void> {
  if (!/^https:\/\/zhuanlan\.zhihu\.com\/(?:write|p\/\d+\/edit)(?:[/?#]|$)/.test(webContents.getURL())) {
    await webContents.loadURL(PUBLISH_URL);
  }
  const deadline = Date.now() + timeoutMs;
  let readyStreak = 0;
  while (Date.now() < deadline) {
    const state = await webContents.executeJavaScript(`(() => {
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
      })();
      const text = String(document.body?.innerText || '');
      const blockingDialog = [...document.querySelectorAll('[role="dialog"],.Modal-wrapper,.Modal-content')]
        .filter(visible).find((element) => /草稿加载中|草稿正在加载|正在加载草稿/.test(String(element.textContent || '')));
      const confirm = blockingDialog ? [...blockingDialog.querySelectorAll('button,[role="button"]')]
        .filter(visible).find((element) => String(element.textContent || '').replace(/\s+/g, '') === '确定') : null;
      if (confirm instanceof HTMLElement) {
        const rect = confirm.getBoundingClientRect();
        return { ready: false, loginBlocked: false, dismiss: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
      }
      const title = document.querySelector(${JSON.stringify(TITLE_SELECTOR)});
      const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
      return {
        ready: title instanceof HTMLTextAreaElement && !title.disabled && !title.readOnly
          && visible(title) && body instanceof HTMLElement && body.isContentEditable && visible(body),
        loginBlocked: /登录知乎|请先登录|扫码登录|验证码|安全验证|验证身份|账号异常/.test(text),
        dismiss: null,
      };
    })()`);
    if (state.loginBlocked) throw new Error('ZHIHU_LOGIN_REQUIRED: 请在桌面端完成知乎登录或验证');
    if (state.dismiss) {
      webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(state.dismiss.x), y: Math.round(state.dismiss.y), button: 'left', clickCount: 1 });
      webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(state.dismiss.x), y: Math.round(state.dismiss.y), button: 'left', clickCount: 1 });
      readyStreak = 0;
      await delay(1000);
      continue;
    }
    readyStreak = state.ready ? readyStreak + 1 : 0;
    if (readyStreak >= 5) return;
    await delay(700);
  }
  throw new Error('ZHIHU_EDITOR_NOT_READY: 知乎编辑器 120 秒内未就绪');
}

async function fillContent(webContents: WebContents, title: string, html: string): Promise<{
  titleFilled: boolean;
  bodyFilled: boolean;
  title: string;
  bodyTextLength: number;
  bodyExpectedLength: number;
  draftWordCount: number;
  draftStateVerified: boolean;
  formatVerification: FormatVerification;
}> {
  const prepared = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/[\\s\\-•·]/g, '');
    const requestedTitle = ${JSON.stringify(title)};
    const sourceHtml = ${JSON.stringify(html)};
    const parser = document.createElement('div');
    parser.innerHTML = sourceHtml;
    const requestedBody = normalize(parser.innerText || parser.textContent || '');
    const count = (root) => ({
      headings: root.querySelectorAll('h2,h3').length,
      lists: root.querySelectorAll('ul,ol').length,
      quotes: root.querySelectorAll('blockquote').length,
      dividers: root.querySelectorAll('hr').length,
      images: root.querySelectorAll('img').length,
    });
    const expected = count(parser);
    const blocks = [...parser.children].flatMap((element) => {
      const tag = element.tagName.toLowerCase();
      const text = normalize(element.innerText || element.textContent || '');
      if (tag === 'p') return text ? [{ type: 'paragraph', text }] : [];
      if (tag === 'h2' || tag === 'h3') return text ? [{ type: 'heading', text, level: Number(tag.slice(1)) }] : [];
      if (tag === 'ul' || tag === 'ol') return [{ type: 'list', ordered: tag === 'ol', items: [...element.querySelectorAll(':scope > li')].map((item) => normalize(item.innerText || item.textContent || '')).filter(Boolean) }];
      if (tag === 'blockquote') return text ? [{ type: 'quote', text }] : [];
      if (tag === 'hr') return [{ type: 'divider' }];
      return text ? [{ type: 'paragraph', text }] : [];
    });
    const titleElement = document.querySelector(${JSON.stringify(TITLE_SELECTOR)});
    const bodyElement = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!(titleElement instanceof HTMLTextAreaElement) || !(bodyElement instanceof HTMLElement)) {
      return { ready: false, expected, requestedBody, blocks, point: null };
    }

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(titleElement, requestedTitle);
    else titleElement.value = requestedTitle;
    titleElement.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: requestedTitle }));
    titleElement.dispatchEvent(new Event('change', { bubbles: true }));

    bodyElement.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = bodyElement.getBoundingClientRect();
    return { ready: true, expected, requestedBody, blocks, point: { x: rect.left + Math.min(rect.width / 2, 320), y: rect.top + Math.min(rect.height / 2, 120) } };
  })()`);
  if (!prepared.ready || !prepared.point) {
    return { titleFilled: false, bodyFilled: false, title: '', bodyTextLength: 0, bodyExpectedLength: prepared.requestedBody?.length || 0, draftWordCount: 0, draftStateVerified: false, formatVerification: { expected: prepared.expected || { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 }, actual: { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 }, preserved: false, degradedBlocks: ['编辑器'] } };
  }

  // Draft.js only persists its React ContentState. Directly replacing the DOM
  // can look correct while the server saves only the final block. Electron's
  // native paste command follows the same editor pipeline as a user paste.
  webContents.focus();
  webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(prepared.point.x), y: Math.round(prepared.point.y), button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(prepared.point.x), y: Math.round(prepared.point.y), button: 'left', clickCount: 1 });
  await delay(250);
  await webContents.executeJavaScript(`(() => {
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!(body instanceof HTMLElement)) return false;
    body.focus({ preventScroll: true });
    const range = document.createRange(); range.selectNodeContents(body);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return true;
  })()`);
  await delay(150);
  const debuggerApi = webContents.debugger;
  const attachedHere = !debuggerApi.isAttached();
  try {
    if (attachedHere) debuggerApi.attach('1.3');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: prepared.point.x, y: prepared.point.y, button: 'left', clickCount: 1 });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: prepared.point.x, y: prepared.point.y, button: 'left', clickCount: 1 });
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers, commands: ['selectAll'] });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, commands: ['deleteBackward'] });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await delay(400);
    let cleared = await webContents.executeJavaScript(`(() => {
      const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
      return body instanceof HTMLElement && !String(body.innerText || body.textContent || '').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
    })()`);
    if (!cleared) {
      webContents.selectAll();
      await delay(120);
      webContents.delete();
      await delay(400);
      cleared = await webContents.executeJavaScript(`(() => {
        const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
        return body instanceof HTMLElement && !String(body.innerText || body.textContent || '').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
      })()`);
    }
    if (!cleared) throw new Error('ZHIHU_CLEAR_FAILED: 旧正文未清空，已停止以避免内容追加');
    const enter = async () => {
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await delay(120);
    };
    const insert = async (text: string) => {
      await debuggerApi.sendCommand('Input.insertText', { text });
      await delay(120);
    };
    const blocks = prepared.blocks as ZhihuInputBlock[];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block) continue;
      if (block.type === 'heading') {
        if (!await setHeadingLevel(webContents, block.level)) await closeFormattingMenu(webContents);
        await insert(block.text);
        await enter();
      } else if (block.type === 'list') {
        if (!await setListStyle(webContents, block.ordered)) await closeFormattingMenu(webContents);
        for (const item of block.items) {
          await insert(item);
          await enter();
        }
        await enter();
      } else if (block.type === 'quote') {
        const quoteEnabled = await clickEditorControl(webContents, ['引用']);
        await insert(block.text);
        await enter();
        if (quoteEnabled) await clickEditorControl(webContents, ['引用']);
      } else if (block.type === 'divider') {
        if (!await clickEditorControl(webContents, ['分割线', '分隔线'])) await insert('---');
        await enter();
      } else {
        await insert(block.text);
        if (index < blocks.length - 1) await enter();
      }
    }
    await delay(1_800);
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }

  let result: any = null;
  let stableStreak = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await delay(500 + attempt * 150);
    result = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const compact = (value) => normalize(value).replace(/[\\s\\-•·]/g, '');
      const requestedTitle = ${JSON.stringify(title)};
      const parser = document.createElement('div');
      parser.innerHTML = ${JSON.stringify(html)};
      const requestedBody = normalize(parser.innerText || parser.textContent || '');
      const count = (root) => ({ headings: root.querySelectorAll('h2,h3').length, lists: root.querySelectorAll('ul,ol').length, quotes: root.querySelectorAll('blockquote').length, dividers: root.querySelectorAll('hr').length, images: root.querySelectorAll('img').length });
      const expected = count(parser);
      const titleElement = document.querySelector(${JSON.stringify(TITLE_SELECTOR)});
      const bodyElement = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
      const actualTitle = titleElement instanceof HTMLTextAreaElement ? normalize(titleElement.value) : '';
      const actualBody = bodyElement instanceof HTMLElement ? normalize(bodyElement.innerText || bodyElement.textContent || '') : '';
      const actual = bodyElement instanceof HTMLElement ? count(bodyElement) : { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 };
      const pageText = normalize(document.body?.innerText || '');
      const wordCount = Number(pageText.match(/字数[：:]\\s*(\\d+)/)?.[1] || 0);
      const expectedCompactLength = compact(requestedBody).length;
      const draftStateVerified = wordCount >= Math.max(1, Math.floor(expectedCompactLength * 0.6));
      const labels = { headings: '小标题', lists: '列表', quotes: '引用', dividers: '分隔线', images: '正文图片' };
      const degradedBlocks = Object.keys(expected).filter((key) => actual[key] < expected[key]).map((key) => labels[key]);
      return {
        titleFilled: actualTitle === normalize(requestedTitle),
        bodyFilled: compact(actualBody) === compact(requestedBody),
        title: actualTitle,
        bodyTextLength: actualBody.length,
        bodyExpectedLength: requestedBody.length,
        draftWordCount: wordCount,
        draftStateVerified,
        formatVerification: { expected, actual, preserved: degradedBlocks.length === 0, degradedBlocks },
      };
    })()`);
    stableStreak = result.titleFilled && result.bodyFilled ? stableStreak + 1 : 0;
    if (stableStreak >= 3) return result;
  }
  result.bodyFilled = false;
  return result;
}

async function openPublishSettings(webContents: WebContents): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })();
      const declarationVisible = [...document.querySelectorAll('body *')]
        .filter(visible).some((element) => normalize(element.textContent) === '创作声明');
      if (declarationVisible) return { opened: true, target: null };
      const button = [...document.querySelectorAll('button,[role="button"]')]
        .filter(visible).find((element) => normalize(element.textContent) === '发布设置');
      if (!(button instanceof HTMLElement)) return { opened: false, target: null };
      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
      return { opened: false, target: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
    })()`);
    if (state.opened) return true;
    if (state.target) {
      webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(state.target.x), y: Math.round(state.target.y), button: 'left', clickCount: 1 });
      webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(state.target.x), y: Math.round(state.target.y), button: 'left', clickCount: 1 });
    }
    await delay(600 + attempt * 250);
  }
  return await webContents.executeJavaScript(`String(document.body?.innerText || '').includes('创作声明')`);
}

async function ensureAiDeclaration(webContents: WebContents): Promise<{ found: boolean; selected: boolean }> {
  const readCurrentSelection = async (): Promise<{ found: boolean; selected: boolean }> => await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const label = [...document.querySelectorAll('body *')]
      .filter(visible).find((element) => normalize(element.textContent) === '创作声明');
    if (!(label instanceof HTMLElement)) return { found: false, selected: false };
    const labelRect = label.getBoundingClientRect();
    let container = label.parentElement;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      const value = [...container.querySelectorAll('button,[role="button"],[role="combobox"],input,div')]
        .filter(visible)
        .filter((element) => element !== label && !element.contains(label))
        .map((element) => ({ element, text: normalize(element.textContent), rect: element.getBoundingClientRect() }))
        .filter(({ text }) => text === '无声明' || (text.length <= 32 && /(?:AI|人工智能)/i.test(text)
          && /(?:辅助创作|创作内容|生成内容|AI创作)/i.test(text)))
        .filter(({ rect }) => rect.width > 40 && rect.height > 18
          && rect.left >= labelRect.right - 20
          && rect.top <= labelRect.bottom + 40 && rect.bottom >= labelRect.top - 40)
        .sort((left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height)[0];
      if (!value) continue;
      return { found: true, selected: value.text.length <= 32 && /(?:AI|人工智能)/i.test(value.text)
        && /(?:辅助创作|创作内容|生成内容|AI创作)/i.test(value.text)
        && !/(?:不包含|未使用|无AI|非AI)/i.test(value.text) };
    }
    return { found: false, selected: false };
  })()`);

  const current = await readCurrentSelection();
  if (current.selected) return current;
  const control = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const label = [...document.querySelectorAll('body *')]
      .filter(visible).find((element) => normalize(element.textContent) === '创作声明');
    if (!(label instanceof HTMLElement)) return { found: false, selected: false, target: null };
    const labelRect = label.getBoundingClientRect();
    let container = label.parentElement;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      const value = [...container.querySelectorAll('button,[role="button"],[role="combobox"],input,div')]
        .filter(visible)
        .filter((element) => element !== label && !element.contains(label))
        .map((element) => ({ element, text: normalize(element.textContent), rect: element.getBoundingClientRect() }))
        .filter(({ text }) => text === '无声明' || (text.length <= 32 && /(?:AI|人工智能)/i.test(text)
          && /(?:辅助创作|创作内容|生成内容|AI创作)/i.test(text)))
        .filter(({ rect }) => rect.width > 40 && rect.height > 18
          && rect.left >= labelRect.right - 20
          && rect.top <= labelRect.bottom + 40 && rect.bottom >= labelRect.top - 40)
        .sort((left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height)[0];
      if (!value) continue;
      const selected = value.text.length <= 32 && /(?:AI|人工智能)/i.test(value.text)
        && /(?:辅助创作|创作内容|生成内容|AI创作)/i.test(value.text)
        && !/(?:不包含|未使用|无AI|非AI)/i.test(value.text);
      value.element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = value.element.getBoundingClientRect();
      return { found: true, selected, target: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
    }
    return { found: false, selected: false, target: null };
  })()`);
  if (!control.found) return { found: false, selected: false };
  if (control.selected) return { found: true, selected: true };
  if (control.target) {
    webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(control.target.x), y: Math.round(control.target.y), button: 'left', clickCount: 1 });
    webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(control.target.x), y: Math.round(control.target.y), button: 'left', clickCount: 1 });
    await delay(700);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      })();
      const positive = (value) => /(?:AI|人工智能)/i.test(value)
        && /(?:辅助创作|创作内容|生成内容|AI创作)/i.test(value)
        && !/(?:不包含|未使用|无AI|非AI)/i.test(value);
      const candidates = [...document.querySelectorAll('label,[role="radio"],[role="option"],[role="menuitem"],button,[role="button"],li')]
        .filter(visible).filter((element) => positive(normalize(element.textContent)));
      const target = candidates.sort((left, right) => {
        const a = left.getBoundingClientRect(); const b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      })[0];
      if (!(target instanceof HTMLElement)) return { found: false, selected: false, target: null };
      const input = target.matches('input') ? target : target.querySelector('input[type="radio"],input[type="checkbox"]');
      const selected = (input instanceof HTMLInputElement && input.checked)
        || target.getAttribute('aria-checked') === 'true'
        || /checked|selected|active/i.test(String(target.className || ''));
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = target.getBoundingClientRect();
      return { found: true, selected, target: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
    })()`);
    if (!state.found) return { found: false, selected: false };
    if (state.selected) return { found: true, selected: true };
    if (state.target) {
      webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(state.target.x), y: Math.round(state.target.y), button: 'left', clickCount: 1 });
      webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(state.target.x), y: Math.round(state.target.y), button: 'left', clickCount: 1 });
    }
    await delay(700 + attempt * 250);
    const verified = await readCurrentSelection();
    if (verified.selected) return verified;
  }
  return await readCurrentSelection();
}

export async function fillZhihuDraft(
  webContents: WebContents,
  title: string,
  html: string,
): Promise<ZhihuDraftFillResult> {
  await ensureZhihuEditor(webContents);
  const content = await fillContent(webContents, title, html);
  if (!content.titleFilled || !content.bodyFilled) {
    throw new Error(`ZHIHU_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}, expectedLength=${content.bodyExpectedLength}, actualLength=${content.bodyTextLength}, draftWordCount=${content.draftWordCount}`);
  }
  await delay(1000);
  const publishSettingsOpened = await openPublishSettings(webContents);
  if (publishSettingsOpened) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const wordCount = await webContents.executeJavaScript(`(() => {
        const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ');
        return Number(text.match(/字数[：:]\\s*(\\d+)/)?.[1] || 0);
      })()`);
      content.draftWordCount = wordCount;
      content.draftStateVerified = wordCount >= Math.max(1, Math.floor(content.bodyExpectedLength * 0.6));
      if (content.draftStateVerified) break;
      await delay(500 + attempt * 150);
    }
  }
  if (!content.draftStateVerified) {
    throw new Error(`ZHIHU_DRAFT_STATE_MISMATCH: 页面正文看似完整，但知乎内部只识别到 ${content.draftWordCount} 字，已停止发布`);
  }
  let declaration = { found: false, selected: false };
  if (publishSettingsOpened) declaration = await ensureAiDeclaration(webContents);
  const finalState = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const publish = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible).some((element) => normalize(element.textContent) === '发布' && !element.hasAttribute('disabled'));
    const declarationLabel = [...document.querySelectorAll('body *')]
      .filter(visible).find((element) => normalize(element.textContent) === '创作声明');
    if (declarationLabel instanceof HTMLElement) declarationLabel.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { publishButtonDetected: publish, url: location.href };
  })()`);
  // 知乎声明下拉框会在 React 状态提交后再绘制，等待稳定后再由调用方采集证据截图。
  await delay(1_500);
  return {
    ...content,
    publishSettingsOpened,
    aiDeclarationFound: declaration.found,
    aiDeclarationSelected: declaration.selected,
    ...finalState,
  };
}
