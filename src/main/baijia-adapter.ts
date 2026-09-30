import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import type { WebContents } from 'electron';
import { baijiaSettingsSchema, defaultBaijiaSettings, type BaijiaSettings } from '../shared/platform-settings.js';

const PUBLISH_URL = 'https://baijiahao.baidu.com/builder/rc/edit';
const BAIJIA_MAX_COVER_DIMENSION = 5_000;
const BAIJIA_MAX_COVER_BYTES = 5 * 1024 * 1024;

export interface BaijiaDraftFillResult {
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
  aiDeclarationSelected: boolean;
  settings?: Record<string, 'enabled' | 'disabled' | 'unsupported'>;
  publishButtonDetected: boolean;
  url: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Baijia rejects some WebP files even though the picker accepts image/*.
 * Convert them in the renderer before passing the path to the native file
 * input, matching the compatibility path used by the previous release. */
export function baijiaCoverUploadFormat(filePath: string): 'original' | 'convert-webp' | 'unsupported' {
  const extension = extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png'].includes(extension)) return 'original';
  if (extension === '.webp') return 'convert-webp';
  return 'unsupported';
}

async function prepareBaijiaCoverUpload(
  webContents: WebContents,
  filePath: string,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const absolutePath = resolve(filePath);
  await access(absolutePath);
  const format = baijiaCoverUploadFormat(absolutePath);
  if (format === 'unsupported') {
    throw new Error('BAIJIA_COVER_FORMAT_UNSUPPORTED: 百家号封面仅支持 JPG、JPEG、PNG 或 WebP');
  }

  const source = await readFile(absolutePath);
  const extension = extname(absolutePath).toLowerCase();
  const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  let dimensions: { width: number; height: number };
  try {
    dimensions = await webContents.executeJavaScript(`(async () => {
      const encoded = ${JSON.stringify(source.toString('base64'))};
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: ${JSON.stringify(mime)} }));
      const result = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return result;
    })()`);
  } catch (error) {
    throw new Error(`BAIJIA_COVER_DECODE_FAILED: 无法读取封面尺寸：${error instanceof Error ? error.message : String(error)}`);
  }

  const needsNormalization = format === 'convert-webp'
    || dimensions.width > BAIJIA_MAX_COVER_DIMENSION
    || dimensions.height > BAIJIA_MAX_COVER_DIMENSION
    || source.length > BAIJIA_MAX_COVER_BYTES;
  if (!needsNormalization) return { filePath: absolutePath, cleanup: async () => undefined };

  const directory = await mkdtemp(join(tmpdir(), 'geo-publisher-baijia-cover-'));
  const convertedPath = join(directory, 'cover.jpg');
  try {
    const jpegBase64 = await webContents.executeJavaScript(`(async () => {
      const encoded = ${JSON.stringify(source.toString('base64'))};
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: ${JSON.stringify(mime)} }));
      try {
        let width = Math.max(1, Math.floor(Math.min(1, ${BAIJIA_MAX_COVER_DIMENSION} / bitmap.width, ${BAIJIA_MAX_COVER_DIMENSION} / bitmap.height) * bitmap.width));
        let height = Math.max(1, Math.floor(Math.min(1, ${BAIJIA_MAX_COVER_DIMENSION} / bitmap.width, ${BAIJIA_MAX_COVER_DIMENSION} / bitmap.height) * bitmap.height));
        let quality = 0.86;
        let dataUrl = '';
        const encodedBytes = (value) => Math.ceil(Math.max(0, value.length - value.indexOf(',') - 1) * 3 / 4);
        for (let pass = 0; pass < 12; pass += 1) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('canvas context unavailable');
          context.drawImage(bitmap, 0, 0, width, height);
          dataUrl = canvas.toDataURL('image/jpeg', quality);
          if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('JPEG encoding failed');
          if (encodedBytes(dataUrl) <= ${BAIJIA_MAX_COVER_BYTES}) break;
          if (quality > 0.5) quality = Math.max(0.5, quality - 0.12);
          else { width = Math.max(640, Math.floor(width * 0.85)); height = Math.max(640, Math.floor(height * 0.85)); }
        }
        if (!dataUrl || encodedBytes(dataUrl) > ${BAIJIA_MAX_COVER_BYTES}) throw new Error('封面压缩后仍超过5MB');
        return dataUrl.slice('data:image/jpeg;base64,'.length);
      } finally {
        bitmap.close();
      }
    })()`);
    const jpeg = Buffer.from(String(jpegBase64), 'base64');
    if (jpeg.length < 3 || jpeg.subarray(0, 3).toString('hex') !== 'ffd8ff' || jpeg.length > BAIJIA_MAX_COVER_BYTES) throw new Error('invalid JPEG');
    await writeFile(convertedPath, jpeg, { mode: 0o600 });
    return { filePath: convertedPath, cleanup: async () => { await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`BAIJIA_COVER_NORMALIZATION_FAILED: 封面尺寸/格式适配失败：${error instanceof Error ? error.message : String(error)}`);
  }
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
    const countStructure = (source) => {
      const root = document.createElement('div'); root.innerHTML = String(source || '');
      return { headings: root.querySelectorAll('h2,h3').length, lists: root.querySelectorAll('ul,ol').length, quotes: root.querySelectorAll('blockquote').length, dividers: root.querySelectorAll('hr').length, images: root.querySelectorAll('img').length };
    };
    const expectedStructure = countStructure(requestedHtml);
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
    if (!(titleEditor instanceof HTMLElement)) return { titleFilled: false, bodyFilled: false, title: '', bodyTextLength: 0, formatVerification: { expected: expectedStructure, actual: { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 }, preserved: false, degradedBlocks: ['编辑器'] }, publishButtonDetected: false, url: location.href };

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
    const actualStructure = countStructure(typeof ueEditor?.getContent === 'function' ? ueEditor.getContent() : body?.innerHTML);
    const labels = { headings: '小标题', lists: '列表', quotes: '引用', dividers: '分隔线', images: '正文图片' };
    const degradedBlocks = Object.keys(expectedStructure).filter((key) => actualStructure[key] < expectedStructure[key]).map((key) => labels[key]);
    return {
      titleFilled: actualTitle === normalize(requestedTitle),
      bodyFilled: bodyText.length > 0,
      title: actualTitle,
      bodyTextLength: bodyText.length,
      formatVerification: { expected: expectedStructure, actual: actualStructure, preserved: degradedBlocks.length === 0, degradedBlocks },
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

const baijiaSettingLabels = {
  autoPodcast: '自动生成播客',
  convertToDynamic: '图文转动态',
  aiGenerated: '采用AI生成内容',
  source: '来源说明',
} as const;

async function applyBaijiaSettings(webContents: WebContents, settings: BaijiaSettings): Promise<Record<string, 'enabled' | 'disabled' | 'unsupported'>> {
  const state = await webContents.executeJavaScript(`(async () => {
    const requested = ${JSON.stringify(settings)};
    const labels = ${JSON.stringify(baijiaSettingLabels)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/\\s+/g, '');
    const visible = (element) => element instanceof HTMLElement && (() => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })();
    const result = {};
    const desired = {
      autoPodcast: requested.smartCreation.includes('autoPodcast'),
      convertToDynamic: requested.smartCreation.includes('convertToDynamic'),
      aiGenerated: requested.declarations.includes('aiGenerated'),
      source: requested.declarations.includes('source'),
    };
    for (const key of Object.keys(labels)) {
      const label = [...document.querySelectorAll('label.cheetah-checkbox-wrapper,label,[role="checkbox"]')].filter(visible)
        .find((element) => compact(element.textContent) === compact(labels[key]));
      if (!(label instanceof HTMLElement)) { result[key] = 'unsupported'; continue; }
      const input = label.querySelector('input[type="checkbox"]');
      if (!(input instanceof HTMLInputElement)) { result[key] = 'unsupported'; continue; }
      if (input.checked !== desired[key]) input.click();
      await new Promise((resolve) => setTimeout(resolve, 450));
      if (input.checked !== desired[key]) return { result, failed: key };
      result[key] = desired[key] ? 'enabled' : 'disabled';
    }
    return { result };
  })()`);
  if (state.failed) throw new Error(`BAIJIA_SETTING_NOT_APPLIED: ${baijiaSettingLabels[state.failed as keyof typeof baijiaSettingLabels]}`);

  if (settings.declarations.includes('source')) {
    const source = await webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[placeholder="请选择时间"]');
      if (!(input instanceof HTMLInputElement)) return { date: false, location: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(settings.sourceDate)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(settings.sourceDate)} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      const selector = document.querySelector('.cheetah-cascader .cheetah-select-selector');
      if (selector instanceof HTMLElement) selector.click();
      return { date: input.value === ${JSON.stringify(settings.sourceDate)}, location: selector instanceof HTMLElement };
    })()`);
    if (!source.date) throw new Error('BAIJIA_SOURCE_DATE_NOT_APPLIED: 未能填写来源时间');
    if (!source.location) throw new Error('BAIJIA_SOURCE_LOCATION_NOT_FOUND: 未找到来源地点选择器');
    const path = settings.sourceLocation.split(/\s*(?:\/|>|，|,)\s*/).filter(Boolean);
    for (const segment of path) {
      await delay(350);
      const selected = await webContents.executeJavaScript(`(() => {
        const text = ${JSON.stringify(segment)};
        const visible = (element) => element instanceof HTMLElement && (() => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })();
        const candidates = [...document.querySelectorAll('.cheetah-cascader-menu-item,[role="option"],li')]
          .filter(visible).filter((element) => String(element.textContent || '').replace(/\\s+/g, ' ').trim() === text);
        const target = candidates[candidates.length - 1];
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()`);
      if (!selected) throw new Error(`BAIJIA_SOURCE_LOCATION_NOT_APPLIED: 未找到来源地点“${segment}”`);
    }
    await delay(500);
    const locationApplied = await webContents.executeJavaScript(`(() => {
      const text = String(document.querySelector('.cheetah-cascader')?.textContent || '').replace(/\\s+/g, '');
      return ${JSON.stringify(path)}.every((segment) => text.includes(String(segment).replace(/\\s+/g, '')));
    })()`);
    if (!locationApplied) throw new Error('BAIJIA_SOURCE_LOCATION_NOT_APPLIED: 来源地点未确认保存');
  }
  return state.result;
}

/**
 * Baijia clears the native file input as soon as it has accepted the file and
 * moved it into the crop dialog. Therefore `input.files.length === 0` does not
 * necessarily mean that the upload failed. Detect the accepted-file dialog
 * before reporting BAIJIA_COVER_FILE_NOT_SELECTED.
 */
async function coverDialogReady(webContents: WebContents): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const isConfirm = (element) => /^(确定|完成|使用)(?:\\s*\\(\\d+\\))?$/.test(normalize(element.textContent));
    const owners = [...document.querySelectorAll('[role="dialog"],[class*="modal"],[class*="Modal"],body')]
      .filter(visible)
      .filter((element) => /封面预览|正文\\/本地上传|本地上传|AI封图|免费正版图库/.test(normalize(element.textContent)));
    return owners.some((owner) => {
      const confirms = [...owner.querySelectorAll('button,[role="button"],[class*="btn"],[class*="button"],div,span')]
        .filter((element) => visible(element) && isConfirm(element));
      const hasImage = [...owner.querySelectorAll('img')].some((image) => {
          const rect = image.getBoundingClientRect();
          const source = String(image.currentSrc || image.src || '');
          return visible(image) && rect.width >= 60 && rect.height >= 40
            && /^(https?:|blob:|data:image\\/)/i.test(source);
        });
      return confirms.some((confirm) => {
        const count = normalize(confirm.textContent).match(/\\((\\d+)\\)$/);
        return Boolean(count && Number(count[1]) > 0) || hasImage;
      });
    });
  })()`);
}

async function confirmCoverDialog(webContents: WebContents): Promise<boolean> {
  const target = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    // Baijia has used both native buttons and custom div/span controls for this
    // dialog. Keep the exact text check so a page-level "确定" is never clicked.
    const buttons = [...document.querySelectorAll('button,[role="button"],[class*="btn"],[class*="button"],div,span')]
      .filter(visible).filter((element) => /^(确定|完成|使用)(?:\\s*\\(\\d+\\))?$/.test(normalize(element.textContent)));
    const button = buttons.find((element) => {
      let owner = element;
      for (let depth = 0; owner && depth < 20; depth += 1, owner = owner.parentElement) {
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
    // Trigger the framework's handler first. Some customer machines do not
    // deliver Electron's synthetic mouse event to this custom dialog.
    button.click();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!target) return false;
  // Give the DOM event a moment to close the modal. If it did not, repeat the
  // click through the renderer input path as a compatibility fallback.
  await delay(450);
  const stillOpen = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    return [...document.querySelectorAll('button,[role="button"],[class*="btn"],[class*="button"],div,span')]
      .filter(visible)
      .some((element) => /^(确定|完成|使用)(?:\\s*\\(\\d+\\))?$/.test(normalize(element.textContent))
        && (() => { let owner = element; for (let depth = 0; owner && depth < 20; depth += 1, owner = owner.parentElement) {
          if (/封面预览|正文\\/本地上传|本地上传|AI封图|免费正版图库/.test(normalize(owner.textContent))) return !/上传中|处理中|正在上传/.test(normalize(owner.textContent));
        } return false; })());
  })()`);
  if (stillOpen) {
    webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 });
    webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 });
  }
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
      if (!text.includes('单图')) continue;
      // Baijia replaces "选择封面" with these controls after applying the image.
      if ((text.includes('编辑') && text.includes('更换')) || /更换封面|重新选择/.test(text)) return true;
      if (!text.includes('选择封面')) continue;
      return [...section.querySelectorAll('img')].some((image) => {
        const source = String(image.currentSrc || image.src || '');
        return visible(image) && /^(https?:|blob:|data:image\\/)/i.test(source);
      });
    }
    return false;
  })()`);
}

async function coverSignature(webContents: WebContents): Promise<string> {
  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const coverLabel = [...document.querySelectorAll('div,span,label')]
      .filter(visible).find((element) => normalize(element.textContent) === '设置封面');
    let section = coverLabel?.parentElement;
    for (let depth = 0; section && depth < 8; depth += 1, section = section.parentElement) {
      const text = normalize(section.textContent);
      if (!text.includes('单图')) continue;
      const image = [...section.querySelectorAll('img')].find((candidate) => {
        const source = String(candidate.currentSrc || candidate.src || '');
        const lowerSource = source.toLowerCase();
        return visible(candidate) && (lowerSource.startsWith('http:')
          || lowerSource.startsWith('https:')
          || lowerSource.startsWith('blob:')
          || lowerSource.startsWith('data:image/'));
      });
      if (!(image instanceof HTMLImageElement)) return '';
      return [image.currentSrc || image.src, image.naturalWidth, image.naturalHeight].join('|');
    }
    return '';
  })()`);
}

async function uploadCover(webContents: WebContents, coverPath: string): Promise<boolean> {
  const prepared = await prepareBaijiaCoverUpload(webContents, coverPath);
  try {
    const opened = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const candidates = [...document.querySelectorAll('button,[role="button"],div,span')]
      .filter(visible)
      .filter((element) => normalize(element.textContent) === '选择封面'
        || element.getAttribute('aria-label') === '更换封面'
        || (element.matches('button,[role="button"]') && normalize(element.textContent) === '更换'));
    const target = candidates.sort((left, right) => {
        const priority = (element) => element.getAttribute('aria-label') === '更换封面' ? 2
          : normalize(element.textContent) === '选择封面' ? 1 : 0;
        const priorityDiff = priority(right) - priority(left);
        if (priorityDiff) return priorityDiff;
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
    await setFileInput(webContents, selector, prepared.filePath);
    const uploadError = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })();
      const selectors = '[role="alert"],[role="status"],[class*="toast"],[class*="Toast"],[class*="message"],[class*="Message"]';
      const candidate = [...document.querySelectorAll(selectors)].filter(visible).map((element) => normalize(element.textContent))
        .find((text) => /图片不能|图片超过|文件大小|格式不支持|上传失败/.test(text));
      return candidate ? candidate.slice(0, 200) : '';
    })()`);
    if (uploadError) throw new Error(`BAIJIA_COVER_REJECTED: ${uploadError}`);
    let fileSelected = false;
    for (let attempt = 0; attempt < 10 && !fileSelected; attempt += 1) {
      fileSelected = await webContents.executeJavaScript(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        return input instanceof HTMLInputElement && Boolean(input.files?.length);
      })()`);
      if (!fileSelected) await delay(300);
    }
    if (!fileSelected && !(await coverDialogReady(webContents))) {
      throw new Error('BAIJIA_COVER_FILE_NOT_SELECTED: 文件已注入但页面未接收到封面文件');
    }
    await delay(800);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const currentSignature = await coverSignature(webContents);
      if (await coverApplied(webContents) && currentSignature) return true;
      const clicked = await confirmCoverDialog(webContents);
      await delay(clicked ? 1_200 : 600);
    }
    const currentSignature = await coverSignature(webContents);
    return Boolean(await coverApplied(webContents) && currentSignature);
  } finally {
    await prepared.cleanup();
  }
}

export async function fillBaijiaDraft(
  webContents: WebContents,
  title: string,
  html: string,
  coverPath: string,
  settings?: Partial<BaijiaSettings>,
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
  if (!content.formatVerification.preserved) {
    throw new Error(`BAIJIA_FORMAT_DEGRADED: 百家号编辑器未保留${content.formatVerification.degradedBlocks.join('、')}`);
  }
  const resolvedSettings = baijiaSettingsSchema.parse({ ...defaultBaijiaSettings, ...(settings || {}) });
  const appliedSettings = await applyBaijiaSettings(webContents, resolvedSettings);
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
  const wantsAi = resolvedSettings.declarations.includes('aiGenerated');
  const finalAiDeclarationSelected = appliedSettings.aiGenerated === 'enabled';
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
    aiDeclarationSelected: wantsAi && finalAiDeclarationSelected,
    settings: appliedSettings,
  };
}
