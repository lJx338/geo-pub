import { access, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { WebContents } from 'electron';

type CoverPlatform = 'zhihu' | 'penguin' | 'sohu';
export interface ArticleCoverResult { coverUploaded: boolean; coverStatus: 'skipped' | 'applied' }
const applied = new WeakMap<WebContents, { url: string; hash: string; signature: string }>();

// Only controls inside the article cover section and its image picker are
// eligible. A body image, upload thumbnail or an unrelated confirmation does
// not prove that the cover was applied.
function coverPage(platform: CoverPlatform, action: 'read' | 'open' | 'local' | 'confirm' | 'select' | 'single' | 'file') {
  const text = (element: Element) => (element.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (element: Element) => {
    const r = element.getBoundingClientRect(), s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const all = (root: ParentNode, selector = '*') => [...root.querySelectorAll(selector)];
  const labelText = platform === 'zhihu' ? '添加封面' : '封面';
  const label = all(document).find(e => visible(e) && (text(e) === labelText ||
    [...e.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim() === labelText));
  let section: Element | null = platform === 'penguin' ? document.querySelector('[class*="articleCoverWrap"]') : label?.parentElement || null;
  for (let depth = 0; section && depth < 5; depth++, section = section.parentElement) {
    if (section === document.body || section.querySelector('[contenteditable="true"],textarea')) { section = null; break; }
    if (section.querySelector('input[type="file"],img,.pic-cover,.cover-button') || /添加文章封面|上传图片|更换封面|编辑封面/.test(text(section)) || platform === 'penguin') break;
  }
  const knownDialogs = all(document, '[role="dialog"],.Modal,.el-dialog');
  const pickerContainers = all(document, 'div,section').filter(e => visible(e) &&
    /本地上传/.test(text(e)) && /确认|确定|上传图片/.test(text(e)) && !e.querySelector('[contenteditable="true"],textarea'));
  const dialogs = [...new Set([...knownDialogs, ...pickerContainers])].filter(e => visible(e) &&
    /封面|裁剪|截取|剪裁|本地上传/.test(text(e)) && !/确认发布|发布文章|提交审核/.test(text(e)));
  const dialog = dialogs.sort((a, b) => text(a).length - text(b).length)[0];
  const images = (root: Element | undefined | null) => root ? all(root, 'img').filter((e): e is HTMLImageElement =>
    e instanceof HTMLImageElement && visible(e) && e.complete && e.naturalWidth >= 100 && e.naturalHeight >= 60) : [];
  const signature = section ? images(section).map(e => e.currentSrc || e.src).concat(all(section).filter(visible).flatMap(e => {
    const r = e.getBoundingClientRect(), bg = getComputedStyle(e).backgroundImage;
    return r.width >= 80 && r.height >= 50 && bg !== 'none' && /url\(/.test(bg) ? [bg] : [];
  })).sort().join('|') : '';
  const error = all(document, '[role="alert"],.el-message,.Toast,.omui-message').filter(visible).map(text)
    .find(value => /上传失败|图片.*(?:过小|过大|超过|不支持|失败)|格式.*(?:不支持|错误)|文件.*(?:过大|超过)/.test(value)) || '';
  const result = { found: Boolean(section), signature, dialog: Boolean(dialog), error, selector: '', point: null as { x: number; y: number } | null };
  const point = (element?: Element | null) => {
    if (!(element instanceof HTMLElement) || !visible(element) || element.matches(':disabled,[aria-disabled="true"],.disable-button,.is--disabled')) return null;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = element.getBoundingClientRect(), p = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    const hit = document.elementFromPoint(p.x, p.y);
    return hit && element.contains(hit) ? p : null;
  };
  const exact = (root: ParentNode | undefined | null, pattern: RegExp) => root ? all(root).filter(e => visible(e) && pattern.test(text(e)))
    .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0] : undefined;
  if (action === 'single' && section) {
    const single = all(section, 'label').find(e => text(e) === '单图');
    if (single && !(single.querySelector('input') as HTMLInputElement | null)?.checked) result.point = point(single);
  }
  if (action === 'open' && section) {
    const add = platform === 'penguin' ? section.querySelector('button[class*="addCoverBtn"]') : undefined;
    result.point = point(exact(section, /^(?:更换封面|更换|重新上传|替换|修改封面|编辑封面)$/) || add ||
      exact(section, /^(?:\+?\s*添加文章封面|[\s\S]*上传图片)$/) || section.querySelector('.pic-cover') || images(section)[0]);
  }
  if (action === 'local' && dialog) result.point = point(exact(dialog, /^本地上传$/));
  if (action === 'file') {
    const root = dialog || section;
    const inputs = root ? all(root, 'input[type="file"]').filter(e => {
      const input = e as HTMLInputElement;
      if (input.disabled || (input.accept && !/image|jpg|jpeg|png/i.test(input.accept))) return false;
      // File inputs themselves can be display:none; their tab must be visible.
      let parent = input.parentElement;
      while (parent && parent !== root) { if (getComputedStyle(parent).display === 'none' || getComputedStyle(parent).visibility === 'hidden') return false; parent = parent.parentElement; }
      return true;
    }) : [];
    if (inputs.length === 1) {
      all(document, '[data-geo-article-cover-file]').forEach(e => e.removeAttribute('data-geo-article-cover-file'));
      inputs[0]!.setAttribute('data-geo-article-cover-file', 'true');
      result.selector = '[data-geo-article-cover-file="true"]';
    }
  }
  if (action === 'confirm' && dialog) {
    // Wait for a decoded image, and never click a disabled upload confirmation.
    if (images(dialog).length || dialog.querySelector('canvas')) result.point = point(exact(dialog, /^(?:确定|确认|完成|保存)$/));
  }
  if (action === 'select' && dialog && !/已选择\s*[1-9]|已选\s*[1-9]/.test(text(dialog))) {
    const uploaded = images(dialog);
    if (uploaded.length === 1) result.point = point(uploaded[0]);
  }
  return result;
}

export async function fillArticleCover(webContents: WebContents, platform: CoverPlatform, coverPath = ''): Promise<ArticleCoverResult> {
  if (!coverPath.trim()) throw new Error('COVER_REQUIRED: 必须选择封面图片');
  const filePath = resolve(coverPath);
  await access(filePath);
  if (!['.png', '.jpg', '.jpeg'].includes(extname(filePath).toLowerCase())) throw new Error(`${platform.toUpperCase()}_COVER_FORMAT_UNSUPPORTED: 封面请使用 PNG、JPG 或 JPEG`);
  const hash = createHash('sha256').update(await readFile(filePath)).digest('hex');
  const inspect = (action: Parameters<typeof coverPage>[1]) => webContents.executeJavaScript(`(${coverPage.toString()})(${JSON.stringify(platform)},${JSON.stringify(action)})`) as Promise<ReturnType<typeof coverPage>>;
  const pause = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
  const debuggerApi = webContents.debugger, owned = !debuggerApi.isAttached();
  if (owned) debuggerApi.attach('1.3');
  const click = async (p: { x: number; y: number } | null) => {
    if (!p) return false;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await pause(); return true;
  };
  try {
    const before = await inspect('read'), previous = applied.get(webContents);
    if (previous?.hash === hash && previous.url === webContents.getURL() && before.signature === previous.signature && !before.dialog) return { coverUploaded: true, coverStatus: 'applied' };
    if (!before.found) throw new Error('未找到文章封面区域');
    await click((await inspect('single')).point);
    let input = await inspect('file');
    if (!input.selector) {
      if (!input.dialog) await click((await inspect('open')).point);
      await click((await inspect('local')).point);
      for (let attempt = 0; attempt < 20; attempt++) {
        input = await inspect('file'); if (input.selector) break; await pause();
      }
    }
    if (!input.selector) throw new Error('未找到唯一的封面上传控件');
    const dom = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const node = await debuggerApi.sendCommand('DOM.querySelector', { nodeId: dom.root.nodeId, selector: input.selector });
    if (!node.nodeId) throw new Error('封面上传控件已失效');
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
    let selected = false, confirmations = 0, stable = 0, signature = '';
    for (let attempt = 0; attempt < 90; attempt++) {
      await pause();
      const state = await inspect('read');
      if (state.error) throw new Error(state.error);
      if (!state.dialog && state.signature && state.signature !== before.signature) {
        stable = state.signature === signature ? stable + 1 : 1; signature = state.signature;
        if (stable >= 3) {
          applied.set(webContents, { hash, url: webContents.getURL(), signature });
          return { coverUploaded: true, coverStatus: 'applied' };
        }
      } else stable = 0;
      if (state.dialog && confirmations < 3) {
        if (await click((await inspect('confirm')).point)) { confirmations++; await pause(1000); }
        else if (!selected && await click((await inspect('select')).point)) selected = true;
      }
    }
    throw new Error('上传后未确认新封面应用到文章，已停止继续发布');
  } catch (error) {
    throw new Error(`${platform.toUpperCase()}_COVER_NOT_APPLIED: ${error instanceof Error ? error.message : String(error)}`);
  } finally { if (owned && debuggerApi.isAttached()) debuggerApi.detach(); }
}
