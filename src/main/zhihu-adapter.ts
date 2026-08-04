import type { WebContents } from 'electron';

const PUBLISH_URL = 'https://zhuanlan.zhihu.com/write';
const TITLE_SELECTOR = 'textarea[placeholder*="请输入标题"]';
const BODY_SELECTOR = '.public-DraftEditor-content[contenteditable="true"][role="textbox"],.public-DraftEditor-content[contenteditable="true"]';

export interface ZhihuDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  title: string;
  bodyTextLength: number;
  publishSettingsOpened: boolean;
  aiDeclarationFound: boolean;
  aiDeclarationSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
}> {
  let result = await webContents.executeJavaScript(`(async () => {
    const normalize = (value) => String(value || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
    const requestedTitle = ${JSON.stringify(title)};
    const sourceHtml = ${JSON.stringify(html)};
    const parser = document.createElement('div');
    parser.innerHTML = sourceHtml;
    const requestedBody = normalize(parser.innerText || parser.textContent || '');
    const titleElement = document.querySelector(${JSON.stringify(TITLE_SELECTOR)});
    const bodyElement = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!(titleElement instanceof HTMLTextAreaElement) || !(bodyElement instanceof HTMLElement)) {
      return { titleFilled: false, bodyFilled: false, title: '', bodyTextLength: 0 };
    }

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(titleElement, requestedTitle);
    else titleElement.value = requestedTitle;
    titleElement.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: requestedTitle }));
    titleElement.dispatchEvent(new Event('change', { bubbles: true }));

    bodyElement.scrollIntoView({ block: 'center', inline: 'nearest' });
    bodyElement.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(bodyElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand('insertText', false, requestedBody);
    if (!inserted) {
      bodyElement.replaceChildren(document.createTextNode(requestedBody));
      bodyElement.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: requestedBody }));
    }
    bodyElement.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const actualTitle = normalize(titleElement.value);
    const actualBody = normalize(bodyElement.innerText || bodyElement.textContent || '');
    return {
      titleFilled: actualTitle === normalize(requestedTitle),
      bodyFilled: actualBody === requestedBody,
      title: actualTitle,
      bodyTextLength: actualBody.length,
    };
  })()`);
  for (let attempt = 0; attempt < 8 && (!result.titleFilled || !result.bodyFilled); attempt += 1) {
    await delay(500 + attempt * 150);
    result = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
      const requestedTitle = ${JSON.stringify(title)};
      const parser = document.createElement('div');
      parser.innerHTML = ${JSON.stringify(html)};
      const requestedBody = normalize(parser.innerText || parser.textContent || '');
      const titleElement = document.querySelector(${JSON.stringify(TITLE_SELECTOR)});
      const bodyElement = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
      const actualTitle = titleElement instanceof HTMLTextAreaElement ? normalize(titleElement.value) : '';
      const actualBody = bodyElement instanceof HTMLElement ? normalize(bodyElement.innerText || bodyElement.textContent || '') : '';
      return {
        titleFilled: actualTitle === normalize(requestedTitle),
        bodyFilled: actualBody.includes(requestedBody.slice(0, Math.min(24, requestedBody.length)))
          && actualBody.includes(requestedBody.slice(-Math.min(24, requestedBody.length))),
        title: actualTitle,
        bodyTextLength: actualBody.length,
      };
    })()`);
  }
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
    let container = label.parentElement;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      const button = [...container.querySelectorAll('button,[role="button"],[role="combobox"]')]
        .filter(visible).find((element) => /声明|AI|人工智能/.test(normalize(element.textContent)));
      if (!(button instanceof HTMLElement)) continue;
      const text = normalize(button.textContent);
      return {
        found: true,
        selected: /(?:AI|人工智能)/i.test(text) && /(?:辅助创作|创作内容|生成内容|AI创作)/i.test(text)
          && !/(?:不包含|未使用|无AI|非AI)/i.test(text),
      };
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
    let container = label.parentElement;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      const button = [...container.querySelectorAll('button,[role="button"],[role="combobox"]')]
        .filter(visible).find((element) => /声明|AI|人工智能/.test(normalize(element.textContent)));
      if (!(button instanceof HTMLElement)) continue;
      const text = normalize(button.textContent);
      const selected = /(?:AI|人工智能)/i.test(text) && /(?:辅助创作|创作内容|生成内容|AI创作)/i.test(text)
        && !/(?:不包含|未使用|无AI|非AI)/i.test(text);
      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
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
    throw new Error(`ZHIHU_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  }
  await delay(1000);
  const publishSettingsOpened = await openPublishSettings(webContents);
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
  await delay(500);
  return {
    ...content,
    publishSettingsOpened,
    aiDeclarationFound: declaration.found,
    aiDeclarationSelected: declaration.selected,
    ...finalState,
  };
}
