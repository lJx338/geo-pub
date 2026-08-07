import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WebContents } from 'electron';

const PUBLISH_URL = 'https://baijiahao.baidu.com/builder/rc/edit';

export interface BaijiaDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  title: string;
  bodyTextLength: number;
  coverUploaded: boolean;
  aiDeclarationSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
    if (!query.nodeId) throw new Error('BAIJIA_COVER_FILE_INPUT_NOT_FOUND');
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: query.nodeId });
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

export async function ensureBaijiaEditor(webContents: WebContents, timeoutMs = 120_000): Promise<void> {
  if (!webContents.getURL().includes('baijiahao.baidu.com/builder/rc/edit')) {
    await webContents.loadURL(PUBLISH_URL);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await webContents.executeJavaScript(`(() => {
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })();
      const title = [...document.querySelectorAll('[contenteditable="true"],input,textarea')]
        .filter(visible)
        .find((element) => String(element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '')
          .includes('标题') || String(element.className || '').includes('FeEditorApp'));
      const iframe = [...document.querySelectorAll('iframe')]
        .find((element) => element instanceof HTMLIFrameElement && visible(element) && element.contentDocument?.body);
      const body = iframe instanceof HTMLIFrameElement ? iframe.contentDocument?.body : null;
      return {
        ready: Boolean(title && (body || window.UE_V2?.instants?.ueditorInstant0)),
        loginBlocked: /(?:passport|login)/i.test(location.href)
          || /百家号登录|百度帐号登录|请先登录|验证码|安全验证/.test(document.body?.innerText || ''),
      };
    })()`);
    if (state.loginBlocked) throw new Error('BAIJIA_LOGIN_REQUIRED: 请在桌面端完成百家号登录或验证');
    if (state.ready) return;
    await delay(500);
  }
  throw new Error('BAIJIA_EDITOR_NOT_READY: 百家号编辑器 120 秒内未就绪');
}

async function fillContent(webContents: WebContents, title: string, html: string): Promise<Omit<BaijiaDraftFillResult, 'coverUploaded' | 'aiDeclarationSelected'>> {
  const result = await webContents.executeJavaScript(`(async () => {
    try {
    const requestedTitle = ${JSON.stringify(title)};
    const requestedHtml = ${JSON.stringify(html)};
    const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const titleEditor = [...document.querySelectorAll('[contenteditable="true"],input,textarea')]
      .filter(visible)
      .filter((element) => !String(element.getAttribute('placeholder') || '').includes('关键词'))
      .sort((left, right) => {
        const score = (element) => {
          const hint = String(element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '');
          return (hint.includes('标题') ? 1000 : 0)
            + (String(element.className || '').includes('FeEditorApp') ? 500 : 0)
            - element.getBoundingClientRect().height;
        };
        return score(right) - score(left);
      })[0];
    if (!(titleEditor instanceof HTMLElement)) return { titleFilled: false, bodyFilled: false, title: '', bodyTextLength: 0, publishButtonDetected: false, url: location.href };

    if (titleEditor instanceof HTMLInputElement || titleEditor instanceof HTMLTextAreaElement) {
      const prototype = titleEditor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(titleEditor, requestedTitle);
    } else {
      const lexicalEditor = titleEditor.__lexicalEditor;
      if (lexicalEditor?.parseEditorState && lexicalEditor?.setEditorState) {
        lexicalEditor.setEditorState(lexicalEditor.parseEditorState(JSON.stringify({ root: {
          children: [{ children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: requestedTitle, type: 'text', version: 1 }], direction: null, format: '', indent: 0, type: 'paragraph', version: 1 }],
          direction: null, format: '', indent: 0, type: 'root', version: 1,
        } })));
      } else {
        titleEditor.replaceChildren(document.createTextNode(requestedTitle));
      }
    }
    titleEditor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: requestedTitle }));
    titleEditor.dispatchEvent(new Event('change', { bubbles: true }));

    const ueEditor = window.UE_V2?.instants?.ueditorInstant0;
    const iframe = [...document.querySelectorAll('iframe')]
      .find((element) => element instanceof HTMLIFrameElement && visible(element) && element.contentDocument?.body);
    const body = iframe instanceof HTMLIFrameElement ? iframe.contentDocument?.body : null;
    if (typeof ueEditor?.setContent === 'function') {
      ueEditor.setContent(requestedHtml);
    } else if (body instanceof HTMLElement) {
      body.innerHTML = requestedHtml;
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      body.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 700));

    const actualTitle = normalize(titleEditor instanceof HTMLInputElement || titleEditor instanceof HTMLTextAreaElement
      ? titleEditor.value : titleEditor.innerText || titleEditor.textContent);
    const bodyText = normalize(typeof ueEditor?.getContentTxt === 'function' ? ueEditor.getContentTxt() : body?.innerText || body?.textContent);
    return {
      titleFilled: actualTitle === normalize(requestedTitle),
      bodyFilled: bodyText.length > 0,
      title: actualTitle,
      bodyTextLength: bodyText.length,
      publishButtonDetected: [...document.querySelectorAll('button,[role="button"]')]
        .filter(visible).some((element) => normalize(element.textContent) === '发布'),
      url: location.href,
    };
    } catch (error) {
      return { error: String(error?.stack || error?.message || error) };
    }
  })()`);
  if (result?.error) throw new Error(result.error);
  await delay(700);
  return result;
}

async function ensureAiDeclaration(webContents: WebContents): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await webContents.executeJavaScript(`(() => {
      const compact = (value) => String(value || '').replace(/\\s+/g, '');
      const label = [...document.querySelectorAll('label.cheetah-checkbox-wrapper,label')]
        .find((element) => compact(element.textContent) === '采用AI生成内容');
      const input = label?.querySelector('input.cheetah-checkbox-input[type="checkbox"],input[type="checkbox"]');
      if (!(label instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return { found: false, selected: false };
      const selected = input.checked && label.classList.contains('cheetah-checkbox-wrapper-checked');
      if (!selected) input.click();
      return { found: true, selected };
    })()`);
    if (!state.found) return false;
    if (state.selected) {
      await delay(700);
      const stable = await webContents.executeJavaScript(`(() => {
        const label = [...document.querySelectorAll('label.cheetah-checkbox-wrapper,label')]
          .find((element) => String(element.textContent || '').replace(/\\s+/g, '') === '采用AI生成内容');
        const input = label?.querySelector('input[type="checkbox"]');
        return input instanceof HTMLInputElement && input.checked
          && label instanceof HTMLElement && label.classList.contains('cheetah-checkbox-wrapper-checked');
      })()`);
      if (stable) return true;
    }
    await delay(500 + attempt * 250);
  }
  return false;
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
      .filter(visible).filter((element) => /^(确定|完成|使用)(?:\\s*\\(\\d+\\))?$/.test(normalize(element.textContent)));
    const button = buttons.find((element) => {
      let owner = element.parentElement;
      for (let depth = 0; owner && depth < 10; depth += 1, owner = owner.parentElement) {
        const ownerText = normalize(owner.textContent);
        if (!/封面预览|正文\\/本地上传|本地上传|AI封图|免费正版图库/.test(ownerText)) continue;
        if (/上传中|处理中|正在上传/.test(ownerText)) return false;
        const buttonText = normalize(element.textContent);
        const count = buttonText.match(/\\((\\d+)\\)$/);
        if (count) return Number(count[1]) > 0;
        return [...owner.querySelectorAll('img')].some((image) => {
          const rect = image.getBoundingClientRect();
          const source = String(image.currentSrc || image.src || '');
          return visible(image) && rect.width >= 60 && rect.height >= 40
            && /^(https?:|blob:|data:image\\/)/i.test(source);
        });
      }
      return false;
    });
    if (!(button instanceof HTMLElement) || button.hasAttribute('disabled')) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!target) return false;
  webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 });
  return true;
}

async function coverApplied(webContents: WebContents): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const modalOpen = [...document.querySelectorAll('[role="dialog"],.cheetah-modal,.cheetah-modal-content')]
      .filter(visible)
      .some((element) => /封面预览|正文\\/本地上传|AI封图|免费正版图库/.test(normalize(element.textContent)));
    if (modalOpen) return false;
    const coverLabel = [...document.querySelectorAll('div,span,label')]
      .filter(visible).find((element) => normalize(element.textContent) === '设置封面');
    let section = coverLabel?.parentElement;
    for (let depth = 0; section && depth < 8; depth += 1, section = section.parentElement) {
      const text = normalize(section.textContent);
      if (!text.includes('单图') || !text.includes('选择封面')) continue;
      return [...section.querySelectorAll('img')].some((image) => {
        const source = String(image.currentSrc || image.src || '');
        return visible(image) && /^(https?:|blob:|data:image\\/)/i.test(source);
      }) || (text.includes('编辑') && text.includes('更换')) || /更换封面|重新选择/.test(text);
    }
    return false;
  })()`);
}

async function uploadCover(webContents: WebContents, coverPath: string): Promise<boolean> {
  const absolutePath = resolve(coverPath);
  await access(absolutePath);
  const opened = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const target = [...document.querySelectorAll('button,[role="button"],div,span')]
      .filter(visible)
      .filter((element) => normalize(element.textContent) === '选择封面')
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      })[0];
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  })()`);
  if (!opened) return false;

  let selector = '';
  for (let attempt = 0; attempt < 40 && !selector; attempt += 1) {
    selector = await webContents.executeJavaScript(`(() => {
      const marker = 'data-geo-desktop-baijia-cover';
      document.querySelectorAll('[' + marker + ']').forEach((element) => element.removeAttribute(marker));
      const target = [...document.querySelectorAll('input[type="file"]')]
        .find((input) => /image|jpg|jpeg|png/i.test(String(input.getAttribute('accept') || 'image')));
      if (!(target instanceof HTMLInputElement)) return '';
      target.setAttribute(marker, 'true');
      return '[' + marker + '="true"]';
    })()`);
    if (!selector) await delay(500);
  }
  if (!selector) return false;
  await setFileInput(webContents, selector, absolutePath);
  await delay(800);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await coverApplied(webContents)) return true;
    const clicked = await confirmCoverDialog(webContents);
    await delay(clicked ? 1_200 : 600);
  }
  return await coverApplied(webContents);
}

export async function fillBaijiaDraft(
  webContents: WebContents,
  title: string,
  html: string,
  coverPath: string,
): Promise<BaijiaDraftFillResult> {
  try {
    await ensureBaijiaEditor(webContents);
  } catch (error) {
    throw new Error(`BAIJIA_EDITOR_STAGE: ${error instanceof Error ? error.message : String(error)}`);
  }
  let content: Omit<BaijiaDraftFillResult, 'coverUploaded' | 'aiDeclarationSelected'>;
  try {
    content = await fillContent(webContents, title, html);
  } catch (error) {
    throw new Error(`BAIJIA_CONTENT_STAGE: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!content.titleFilled || !content.bodyFilled) {
    throw new Error(`BAIJIA_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  }
  let aiDeclarationSelected: boolean;
  try {
    aiDeclarationSelected = await ensureAiDeclaration(webContents);
  } catch (error) {
    throw new Error(`BAIJIA_AI_DECLARATION_STAGE: ${error instanceof Error ? error.message : String(error)}`);
  }
  let coverUploaded: boolean;
  try {
    coverUploaded = await uploadCover(webContents, coverPath);
  } catch (error) {
    throw new Error(`BAIJIA_COVER_STAGE: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (let attempt = 0; !coverUploaded && attempt < 8; attempt += 1) {
    await delay(1_000);
    coverUploaded = await coverApplied(webContents);
  }
  if (!coverUploaded) throw new Error('BAIJIA_COVER_NOT_APPLIED: 封面上传后未确认应用状态');
  const finalAiDeclarationSelected = await ensureAiDeclaration(webContents);
  if (!finalAiDeclarationSelected && !aiDeclarationSelected) {
    throw new Error('BAIJIA_AI_DECLARATION_NOT_SELECTED: 未确认“采用AI生成内容”');
  }
  await webContents.executeJavaScript(`(() => {
    const label = [...document.querySelectorAll('label.cheetah-checkbox-wrapper,label')]
      .find((element) => String(element.textContent || '').replace(/\\s+/g, '') === '采用AI生成内容');
    if (label instanceof HTMLElement) label.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(label);
  })()`);
  await delay(500);
  return {
    ...content,
    coverUploaded,
    aiDeclarationSelected: finalAiDeclarationSelected || aiDeclarationSelected,
  };
}
