import { access } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { cdpClick } from './browser-automation-driver.js';
import { classifyDraftBlockCount, contentMatchesExpected } from './content-verification.js';

const PUBLISH_URL = 'https://mp.163.com/subscribe_v4/index.html#/article-publish';

type NeteaseFormatCounts = { headings: number; lists: number; quotes: number; dividers: number; images: number };
type NeteaseInputBlock =
  | {type:'paragraph';text:string;bold:boolean}
  | {type:'heading';text:string}
  | {type:'list';items:string[];ordered:boolean}
  | {type:'quote';text:string};

export type NeteaseSourceBlockDescriptor = {
  tag: string;
  text: string;
  listItemCount: number;
};

export function countNeteaseExpectedBlocks(blocks: NeteaseSourceBlockDescriptor[]): number {
  return blocks.reduce((count, block) => {
    if (block.tag === 'hr' || !block.text) return count;
    if (block.tag === 'ul' || block.tag === 'ol') return count + block.listItemCount;
    return count + 1;
  }, 0);
}

export function neteaseEditorNeedsReset(state: { textLength: number; imageCount: number }): boolean {
  return state.textLength > 0 || state.imageCount > 0;
}

/** A stale draft may be restored after the first editor-ready check. Reset it once, then stop. */
export function shouldRetryNeteaseOwnedDraftReset(hasEditorContent: boolean, resetAttempted: boolean): boolean {
  return hasEditorContent && !resetAttempted;
}

export function neteaseBlockTextsMatch(actualBlocks: unknown[], expectedBlocks: unknown[]): boolean {
  const normalizeBlock = (value: unknown) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return actualBlocks.length === expectedBlocks.length
    && actualBlocks.every((block, index) => normalizeBlock(block) === normalizeBlock(expectedBlocks[index]));
}

export function neteaseBlockMismatchIndex(actualBlocks: unknown[], expectedBlocks: unknown[]): number | null {
  if (actualBlocks.length !== expectedBlocks.length) return Math.min(actualBlocks.length, expectedBlocks.length);
  const normalizeBlock = (value: unknown) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const index = actualBlocks.findIndex((block, position) => normalizeBlock(block) !== normalizeBlock(expectedBlocks[position]));
  return index < 0 ? null : index;
}

export type NeteaseContentVerification = 'exact_blocks' | 'equivalent_text' | 'mismatch';

/**
 * Draft.js may add wrappers or split a source block without changing any user
 * content. Treat that as a format warning only when every normalized character
 * and the top-level block count still agree; never accept a substring or a
 * sampled match.
 */
export function verifyNeteaseContentBlocks(actualBlocks: unknown[], expectedBlocks: unknown[]): NeteaseContentVerification {
  if (neteaseBlockTextsMatch(actualBlocks, expectedBlocks)) return 'exact_blocks';
  const canonical = (blocks: unknown[]) => blocks.map((value) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, '')).join('');
  const actual = canonical(actualBlocks);
  const expected = canonical(expectedBlocks);
  return actual.length > 0 && actual === expected && actualBlocks.length === expectedBlocks.length
    ? 'equivalent_text'
    : 'mismatch';
}

export function normalizeNeteaseExpectedFormat(counts: NeteaseFormatCounts): NeteaseFormatCounts {
  // NetEase Draft.js has no stable divider control. Source <hr> elements are
  // represented by paragraph spacing and must not fail an otherwise valid draft.
  return { ...counts, dividers: 0 };
}

export interface NeteaseDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  formatVerification: {
    expected: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    actual: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    preserved: boolean;
    degradedBlocks: string[];
  };
  formatWarnings?: string[];
  expectedBlockCount?: number;
  actualBlockCount?: number;
  blockVerification?: { expectedCount: number; actualCount: number; mismatchIndex: number | null };
  contentVerification?: NeteaseContentVerification;
  bodyImageInserted: boolean;
  autoCoverSelected: boolean;
  aiDeclarationFound: boolean;
  aiDeclarationSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const normalize = (value: unknown) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

async function readNeteaseEditorState(webContents: WebContents): Promise<{ textLength: number; imageCount: number }> {
  return await webContents.executeJavaScript(`(() => {
    const editor=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
    if (!(editor instanceof HTMLElement)) return {textLength:-1,imageCount:-1};
    const text=[...editor.querySelectorAll('[data-text="true"]')]
      .map((node)=>String(node.textContent||''))
      .join('')
      .replace(/[\u200b-\u200d\ufeff]/g,'')
      .trim();
    return {textLength:text.length,imageCount:editor.querySelectorAll('.rich-editor-image-container img').length};
  })()`);
}

async function waitForNeteaseEditorEmpty(webContents: WebContents, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const state = await readNeteaseEditorState(webContents);
    stableSamples = !neteaseEditorNeedsReset(state) ? stableSamples + 1 : 0;
    if (stableSamples >= 6) return true;
    await delay(200);
  }
  return false;
}

async function clearNeteaseEditor(webContents: WebContents): Promise<void> {
  const initial = await readNeteaseEditorState(webContents);
  if (initial.textLength < 0 || initial.imageCount < 0) {
    throw new Error('NETEASE_EDITOR_NOT_READY: 找不到正文编辑器');
  }
  if (!neteaseEditorNeedsReset(initial)) return;

  const debuggerApi = webContents.debugger;
  const attachedHere = !debuggerApi.isAttached();
  try {
    if (attachedHere) debuggerApi.attach('1.3');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await webContents.focus();
      const point = await webContents.executeJavaScript(`(() => {
        const editor=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        if (!(editor instanceof HTMLElement)) return null;
        editor.scrollIntoView({block:'center',inline:'nearest'});
        const rect=editor.getBoundingClientRect();
        return {x:rect.left+Math.min(rect.width/2,320),y:rect.top+Math.min(rect.height/2,120)};
      })()`);
      if (!point) throw new Error('NETEASE_EDITOR_NOT_READY: 找不到正文编辑器');
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1 });
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1 });
      const selectionReady = await webContents.executeJavaScript(`(() => {
        const editor=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        if (!(editor instanceof HTMLElement)) return false;
        editor.focus({preventScroll:true});
        const range=document.createRange(); range.selectNodeContents(editor);
        const selection=window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        return document.activeElement===editor&&Boolean(selection?.rangeCount);
      })()`);
      if (!selectionReady) throw new Error('NETEASE_CLEAR_SELECTION_FAILED: 无法选中旧正文');
      const modifiers = process.platform === 'darwin' ? 4 : 2;
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers, commands:['selectAll'] });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Backspace', code:'Backspace', windowsVirtualKeyCode:8, commands:['deleteBackward'] });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', key:'Backspace', code:'Backspace', windowsVirtualKeyCode:8 });
      if (await waitForNeteaseEditorEmpty(webContents)) return;
    }
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }
  const state = await readNeteaseEditorState(webContents);
  throw new Error(`NETEASE_CLEAR_FAILED: 旧草稿未稳定清空 ${JSON.stringify(state)}`);
}

function isTransientPageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Render frame was disposed|frame was detached|Object has been destroyed|ERR_ABORTED|navigation|target closed/i.test(message);
}

function visibleScript(): string {
  return `(element) => element instanceof HTMLElement && (() => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })()`;
}

async function clickNeteaseEditorTool(webContents: WebContents, iconName: string): Promise<boolean> {
  const point = await webContents.executeJavaScript(`(() => {
    const visible=${visibleScript()};
    const button=[...document.querySelectorAll('button.rich-editor-panel-item')]
      .find((candidate)=>visible(candidate)&&[...candidate.querySelectorAll('img')]
        .some((image)=>String(image.getAttribute('src')||'').includes(${JSON.stringify(`icon_${iconName}`)})));
    if (!(button instanceof HTMLElement)) return null;
    const rect=button.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  if (!point) return false;
  await cdpClick(webContents, { x: Math.round(point.x), y: Math.round(point.y) });
  await delay(220);
  return true;
}

async function focusNeteaseEditorEnd(webContents: WebContents): Promise<boolean> {
  await webContents.focus();
  return await webContents.executeJavaScript(`(() => {
    const editor=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus({preventScroll:true});
    const target=editor.querySelector('[data-block="true"]:last-child [data-text="true"]')?.lastChild
      ||editor.querySelector('[data-block="true"]:last-child')||editor;
    const range=document.createRange(); range.selectNodeContents(target); range.collapse(false);
    const selection=window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return document.activeElement===editor&&Boolean(selection?.anchorNode&&editor.contains(selection.anchorNode));
  })()`);
}

async function pressNeteaseEnterWindows(webContents: WebContents, debuggerApi: Electron.Debugger): Promise<void> {
  const before = await webContents.executeJavaScript(`(() => document.querySelectorAll('.public-DraftEditor-content[contenteditable="true"] [data-block="true"]').length)()`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!await focusNeteaseEditorEnd(webContents)) throw new Error('NETEASE_EDITOR_CARET_FAILED: Windows 换段前无法恢复正文光标');
    await webContents.executeJavaScript(`window.__geoPublisherInputMethod='cdp.keyDown.windows'`);
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\n', unmodifiedText: '\n',
    });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const current = await webContents.executeJavaScript(`(() => document.querySelectorAll('.public-DraftEditor-content[contenteditable="true"] [data-block="true"]').length)()`);
      if (current === before + 1) { await focusNeteaseEditorEnd(webContents); return; }
      if (current > before + 1) throw new Error(`NETEASE_PARAGRAPH_BREAK_UNCERTAIN: Windows 一次换段产生了 ${current - before} 个新段落`);
      await delay(120);
    }
  }
  throw new Error(`NETEASE_PARAGRAPH_BREAK_FAILED: Windows 换段后段落数未从 ${before} 变为 ${before + 1}`);
}

async function selectNeteaseBlockRange(webContents: WebContents, start: number, end: number): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const editor=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    const blocks=[...editor.querySelectorAll('[data-block="true"]')];
    const first=blocks[${start}], last=blocks[${end}];
    if (!(first instanceof HTMLElement)||!(last instanceof HTMLElement)) return false;
    editor.focus({preventScroll:true});
    const range=document.createRange(); range.setStart(first,0); range.setEnd(last,last.childNodes.length);
    const selection=window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange',{bubbles:true}));
    return Boolean(selection?.rangeCount);
  })()`);
}

async function applyNeteaseWindowsFormatting(webContents: WebContents, blocks: NeteaseInputBlock[]): Promise<void> {
  let offset = 0;
  for (const block of blocks) {
    const length = block.type === 'list' ? block.items.length : 1;
    const start = offset;
    const end = offset + length - 1;
    offset += length;
    const needsFormat = block.type !== 'paragraph' || block.bold;
    if (!needsFormat || !await selectNeteaseBlockRange(webContents, start, end)) continue;
    if (block.type === 'heading') await clickNeteaseEditorTool(webContents, 'h5');
    else if (block.type === 'list') await clickNeteaseEditorTool(webContents, block.ordered ? 'ordered_list_item' : 'unordered_list_item');
    else if (block.type === 'quote') await clickNeteaseEditorTool(webContents, 'blockquote');
    else if (block.bold) await clickNeteaseEditorTool(webContents, 'bold');
    await delay(300);
  }
  await focusNeteaseEditorEnd(webContents);
}

async function ensureEditor(webContents: WebContents): Promise<void> {
  // The session layer has already loaded a fresh page for a new platform job.
  // Reloading this hash-routed editor a second time can SIGTRAP Electron on macOS.
  // Existing content is safely replaced through Draft.js selection in fillText.
  if (!webContents.getURL().includes('article-publish')) {
    await webContents.loadURL(PUBLISH_URL);
  }
  const deadline = Date.now() + 120_000;
  let transientFailures = 0;
  let readyStreak = 0;
  while (Date.now() < deadline) {
    let state: { ready: boolean; login: boolean };
    try {
      state = await webContents.executeJavaScript(`(() => {
        const visible = ${visibleScript()};
        const text = String(document.body ? document.body.innerText : '');
        const fields = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
        return { ready: fields.length >= 2, login: /登录|扫码|验证码|安全验证|账号异常/.test(text) && fields.length < 2 };
      })()`);
      transientFailures = 0;
    } catch (error) {
      if (!isTransientPageError(error)) throw error;
      transientFailures += 1;
      if (transientFailures >= 3 && !webContents.isLoading()) {
        webContents.reload();
        transientFailures = 0;
      }
      await delay(900);
      continue;
    }
    if (state.login) throw new Error('NETEASE_LOGIN_REQUIRED: 请在当前桌面端完成网易号登录');
    readyStreak = state.ready ? readyStreak + 1 : 0;
    if (readyStreak >= 3) return;
    await delay(800);
  }
  throw new Error('NETEASE_EDITOR_NOT_READY: 网易号图文编辑器 120 秒内未就绪');
}

async function fillText(webContents: WebContents, title: string, html: string): Promise<{
  titleFilled: boolean;
  bodyFilled: boolean;
  expectedBlockCount?: number;
  actualBlockCount?: number;
  blockVerification?: { expectedCount: number; actualCount: number; mismatchIndex: number | null };
  contentVerification?: NeteaseContentVerification;
  formatVerification: NeteaseDraftFillResult['formatVerification'];
}> {
  const bodyText = await webContents.executeJavaScript(`(() => { const parser=document.createElement('div'); parser.innerHTML=${JSON.stringify(html)}; return String(parser.innerText||parser.textContent||'').replace(/\\u00a0/g,' ').trim(); })()`);
  // Reset the existing Draft.js content before changing the title so a failed
  // clear cannot leave the draft partially mutated.
  await clearNeteaseEditor(webContents);
  const setTitle = async (): Promise<boolean> => {
    return await webContents.executeJavaScript(`(async () => {
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const compact=(value)=>normalize(value).replace(/[\\s\\-•·]/g,'');
      const element=document.querySelector('textarea.netease-textarea,textarea[placeholder*="标题"]');
      if (!(element instanceof HTMLTextAreaElement)) return false;
      element.scrollIntoView({block:'center',inline:'nearest'});
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      if (setter) setter.call(element, ${JSON.stringify(title)}); else element.value=${JSON.stringify(title)};
      element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(title)}}));
      element.dispatchEvent(new Event('change',{bubbles:true}));
      element.dispatchEvent(new Event('blur',{bubbles:true}));
      return normalize(element.value)===normalize(${JSON.stringify(title)});
    })()`);
  };
  const setBody = async (resetAttempted = false): Promise<boolean> => {
    const prepared = await webContents.executeJavaScript(`(() => {
      const contentMatchesExpected=${contentMatchesExpected.toString()};
      const neteaseBlockTextsMatch=${neteaseBlockTextsMatch.toString()};
      const verifyNeteaseContentBlocks=${verifyNeteaseContentBlocks.toString()};
      const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      if (!(element instanceof HTMLElement)) return null;
      const editableText=()=>[...element.querySelectorAll('[data-text="true"]')]
        .map((node)=>String(node.textContent||'')).join('\\n').trim();
      const currentText=editableText();
      const parser=document.createElement('div');
      parser.innerHTML=${JSON.stringify(html)};
      const expectedStructure={headings:parser.querySelectorAll('h2,h3').length,lists:parser.querySelectorAll('ul,ol').length,quotes:parser.querySelectorAll('blockquote').length};
      const actualStructure={headings:element.querySelectorAll('h2,h3,h4,h5,h6').length,lists:element.querySelectorAll('ul,ol').length,quotes:element.querySelectorAll('blockquote').length};
      const imageCount=element.querySelectorAll('.rich-editor-image-container img').length;
      const structureMatches=actualStructure.headings>=expectedStructure.headings&&actualStructure.lists>=expectedStructure.lists&&actualStructure.quotes>=expectedStructure.quotes;
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const blocks=[...parser.children].flatMap((child)=>{
        const tag=child.tagName.toLowerCase();
        const text=normalize(child.textContent);
        if (tag==='h2'||tag==='h3') return text?[{type:'heading',text}]:[];
        if (tag==='p') return text?[{type:'paragraph',text,bold:Boolean(child.querySelector('strong,b'))}]:[];
        if (tag==='ul'||tag==='ol') return [{type:'list',ordered:tag==='ol',items:[...child.querySelectorAll(':scope > li')].map((item)=>normalize(item.textContent)).filter(Boolean)}];
        if (tag==='blockquote') return text?[{type:'quote',text}]:[];
        return text?[{type:'paragraph',text,bold:false}]:[];
      });
      const expectedBlockTexts=blocks.flatMap((block)=>block.type==='list'?block.items:[block.text]);
      const actualBlockTexts=[...element.querySelectorAll('[data-block="true"]')].map((block)=>String(block.textContent||''));
      const bodyMatches=verifyNeteaseContentBlocks(actualBlockTexts, expectedBlockTexts)!=='mismatch';
      if (bodyMatches&&structureMatches) return {alreadyMatches:true,bodyMatches:true,headingTexts:[],point:null};
      const plainText=blocks.flatMap((block)=>block.type==='list'?block.items:[block.text]).join('\\n').trim();
      if (!plainText) return null;
      element.scrollIntoView({block:'center',inline:'nearest'});
      const rect=element.getBoundingClientRect();
      return {
        alreadyMatches:false,
        bodyMatches,
        hasEditorContent:Boolean(currentText)||imageCount>0,
        headingTexts:[...parser.querySelectorAll('h2,h3')].map((heading)=>normalize(heading.textContent)).filter(Boolean),
        blocks,
        plainText,
        point:{x:rect.left+Math.min(rect.width/2,320),y:rect.top+Math.min(rect.height/2,120)}
      };
    })()`);
    if (prepared?.alreadyMatches) return true;
    if (!prepared?.point || !prepared.plainText) return false;
    const applyHeadings = async (): Promise<boolean> => {
      for (const headingText of prepared.headingTexts as string[]) {
        const state = await webContents.executeJavaScript(`(() => {
          const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
          const editor=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
          if (!(editor instanceof HTMLElement)) return {found:false,formatted:false};
          const block=[...editor.querySelectorAll('[data-block="true"]')].find((candidate)=>normalize(candidate.textContent)===normalize(${JSON.stringify(headingText)}));
          if (!(block instanceof HTMLElement)) return {found:false,formatted:false};
          if (block.matches('h2,h3,h4,h5,h6')||Boolean(block.querySelector('h2,h3,h4,h5,h6'))) return {found:true,formatted:true};
          editor.focus({preventScroll:true});
          const target=block.querySelector('[data-text="true"]')?.firstChild||block;
          const range=document.createRange(); range.selectNodeContents(target); range.collapse(true);
          const selection=window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
          return {found:true,formatted:false};
        })()`);
        if (!state.found) return false;
        if (!state.formatted && !await clickNeteaseEditorTool(webContents,'h5')) return false;
        await delay(350);
      }
      return await webContents.executeJavaScript(`(() => {
        const editor=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        return editor instanceof HTMLElement&&editor.querySelectorAll('h2,h3,h4,h5,h6').length>=${prepared.headingTexts.length};
      })()`);
    };
    if (prepared.bodyMatches) {
      if (await applyHeadings()) return true;
      if (process.platform === 'win32') return true;
      throw new Error('NETEASE_HEADING_FORMAT_FAILED: 已填正文中的小标题无法转换');
    }
    if (shouldRetryNeteaseOwnedDraftReset(Boolean(prepared.hasEditorContent), resetAttempted)) {
      await clearNeteaseEditor(webContents);
      await delay(450);
      return await setBody(true);
    }
    if (prepared.hasEditorContent) {
      throw new Error('NETEASE_EDITOR_NOT_EMPTY: 新建编辑会话仍包含旧草稿，已停止填充以避免重复内容');
    }

    // 网易和知乎都使用 Draft.js。只有 Chromium 的真实输入管线会同步
    // React ContentState；DOM Range、innerHTML 和合成 paste 都可能只改表象。
    const debuggerApi = webContents.debugger;
    const attachedHere = !debuggerApi.isAttached();
    try {
      if (attachedHere) debuggerApi.attach('1.3');
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
        type:'mousePressed', x:prepared.point.x, y:prepared.point.y, button:'left', clickCount:1,
      });
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
        type:'mouseReleased', x:prepared.point.x, y:prepared.point.y, button:'left', clickCount:1,
      });
      const selectionPrepared = await webContents.executeJavaScript(`(() => {
        const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        if (!(element instanceof HTMLElement)) return false;
        element.focus({preventScroll:true});
        const target=element.querySelector('[data-text="true"]')?.firstChild
          ||element.querySelector('[data-block="true"]')||element;
        const range=document.createRange();
        range.selectNodeContents(target);
        range.collapse(true);
        const selection=window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return document.activeElement===element;
      })()`);
      if (!selectionPrepared) throw new Error('NETEASE_EDITOR_CARET_FAILED: 无法在正文编辑器内建立光标');
      await delay(180);
      const clearedState = await webContents.executeJavaScript(`(() => {
        const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        if (!(element instanceof HTMLElement)) return {cleared:false,textLength:-1,imageCount:-1};
        const text=[...element.querySelectorAll('[data-text="true"]')]
          .map((node)=>String(node.textContent||'')).join('').replace(/[\\u200b-\\u200d\\ufeff]/g,'').trim();
        const imageCount=element.querySelectorAll('.rich-editor-image-container img').length;
        return {cleared:!text&&imageCount===0,textLength:text.length,imageCount};
      })()`);
      if (!clearedState.cleared) throw new Error(`NETEASE_CLEAR_FAILED: ${JSON.stringify(clearedState)}`);
      // Draft.js must be written through CDP instead of the system clipboard.
      const inheritedHeading = await webContents.executeJavaScript(`(() => {
        const selection=window.getSelection();
        const node=selection?.anchorNode;
        const element=node instanceof Element?node:node?.parentElement;
        return Boolean(element?.closest('h1,h2,h3,h4,h5,h6'));
      })()`);
      if (inheritedHeading) await clickNeteaseEditorTool(webContents,'h5');
      const enter = async () => {
        if (process.platform === 'win32') return await pressNeteaseEnterWindows(webContents, debuggerApi);
        await debuggerApi.sendCommand('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        await debuggerApi.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        await delay(100);
      };
      const insert = async (text: string) => {
        if (process.platform === 'win32') await webContents.executeJavaScript(`window.__geoPublisherInputMethod='cdp.insertText'`);
        await debuggerApi.sendCommand('Input.insertText',{text});
        await delay(100);
      };
      const blocks = prepared.blocks as NeteaseInputBlock[];
      if (process.platform === 'win32') {
        const plainBlocks = blocks.flatMap((block) => block.type === 'list' ? block.items : [block.text]);
        for (let index = 0; index < plainBlocks.length; index += 1) {
          await focusNeteaseEditorEnd(webContents);
          await insert(plainBlocks[index] || ' ');
          if (index < plainBlocks.length - 1) await enter();
        }
        await applyNeteaseWindowsFormatting(webContents, blocks);
      } else for (let index=0;index<blocks.length;index+=1) {
        const block=blocks[index];
        if (!block) continue;
        if (block.type==='list') {
          if (!await clickNeteaseEditorTool(webContents,block.ordered?'ordered_list_item':'unordered_list_item')) {
            throw new Error('NETEASE_LIST_TOOL_MISSING: 未找到列表工具');
          }
          for (const item of block.items) { await insert(item); await enter(); }
          await enter();
        } else if (block.type==='quote') {
          if (!await clickNeteaseEditorTool(webContents,'blockquote')) throw new Error('NETEASE_QUOTE_TOOL_MISSING: 未找到引用工具');
          await insert(block.text);
          await enter();
          await clickNeteaseEditorTool(webContents,'blockquote');
        } else if (block.type==='heading') {
          if (!await clickNeteaseEditorTool(webContents,'h5')) throw new Error('NETEASE_HEADING_TOOL_MISSING: 未找到小标题工具');
          await insert(block.text);
          if (index<blocks.length-1) await enter();
          await clickNeteaseEditorTool(webContents,'h5');
        } else {
          if (block.bold) await clickNeteaseEditorTool(webContents,'bold');
          await insert(block.text);
          if (block.bold) await clickNeteaseEditorTool(webContents,'bold');
          if (index<blocks.length-1) await enter();
        }
      }
      await delay(1_800);
      return await webContents.executeJavaScript(`(() => {
        const actual=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        const expected=${JSON.stringify((prepared.blocks as NeteaseInputBlock[]).flatMap((block) => block.type === 'list' ? block.items : [block.text]))};
        const actualBlocks=actual instanceof HTMLElement?[...actual.querySelectorAll('[data-block="true"]')].map((node)=>String(node.textContent||'')):[];
        const neteaseBlockTextsMatch=${neteaseBlockTextsMatch.toString()};
        const verifyNeteaseContentBlocks=${verifyNeteaseContentBlocks.toString()};
        return actual instanceof HTMLElement&&verifyNeteaseContentBlocks(actualBlocks,expected)!=='mismatch';
      })()`);
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  };
  let titleWritten = false;
  for (let attempt = 0; attempt < 3 && !titleWritten; attempt += 1) {
    try {
      titleWritten = await setTitle();
    } catch (error) {
      if (!isTransientPageError(error)) throw error;
    }
    if (!titleWritten) await delay(700 + attempt * 500);
  }
  const emptyFormat = { expected: { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 }, actual: { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 }, preserved: false, degradedBlocks: ['编辑器'] };
  if (!titleWritten) return { titleFilled: false, bodyFilled: false, formatVerification: emptyFormat };
  await delay(700);
  let bodyWritten = false;
  for (let attempt = 0; attempt < 3 && !bodyWritten; attempt += 1) {
    try {
      bodyWritten = await setBody();
    } catch (error) {
      if (!isTransientPageError(error)) throw error;
    }
    if (!bodyWritten) await delay(900 + attempt * 600);
  }
  if (!bodyWritten) return { titleFilled: true, bodyFilled: false, formatVerification: emptyFormat };
  await delay(1200);
  // 网易号的受控标题会在正文触发自动保存时偶发回写旧值。正文完成后重新核验，
  // 最多补写两次；每次都以页面真实 value 为准，避免把成功误判为失败。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentTitleMatches = await webContents.executeJavaScript(`(() => {
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const element=document.querySelector('textarea.netease-textarea,textarea[placeholder*="标题"]');
      return element instanceof HTMLTextAreaElement&&normalize(element.value)===normalize(${JSON.stringify(title)});
    })()`);
    if (currentTitleMatches) break;
    await setTitle();
    await delay(900);
  }
  let verified = await webContents.executeJavaScript(`(() => {
    const normalize=(v)=>String(v||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
    const parser=document.createElement('div'); parser.innerHTML=${JSON.stringify(html)}; const expected=normalize(parser.innerText||parser.textContent||'');
    const titleEl=document.querySelector('textarea.netease-textarea,textarea[placeholder*="标题"]');
    const bodyEl=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
    const actualTitle=titleEl instanceof HTMLTextAreaElement?normalize(titleEl.value):''; const actualBody=bodyEl instanceof HTMLElement?normalize([...bodyEl.querySelectorAll('[data-text="true"]')].map((node)=>String(node.textContent||'')).join('\\n')):'';
    const compact=(value)=>normalize(value).replace(/[\\s\\-•·]/g,'');
    const contentMatchesExpected=${contentMatchesExpected.toString()};
    const neteaseBlockTextsMatch=${neteaseBlockTextsMatch.toString()};
    const neteaseBlockMismatchIndex=${neteaseBlockMismatchIndex.toString()};
    const verifyNeteaseContentBlocks=${verifyNeteaseContentBlocks.toString()};
    const count=(root,actual=false)=>({headings:root.querySelectorAll(actual?'h2,h3,h4,h5,h6':'h2,h3').length,lists:root.querySelectorAll('ul,ol').length,quotes:root.querySelectorAll('blockquote').length,dividers:root.querySelectorAll('hr').length,images:root.querySelectorAll('img').length});
    const source=document.createElement('div'); source.innerHTML=${JSON.stringify(html)};
    const expectedBlocks=[...source.children].flatMap((node)=>['ul','ol'].includes(node.tagName.toLowerCase())?[...node.querySelectorAll(':scope > li')].map((item)=>String(item.textContent||'')):(node.tagName.toLowerCase()==='hr'?[]:[String(node.textContent||'')]));
    const actualBlocks=bodyEl instanceof HTMLElement?[...bodyEl.querySelectorAll('[data-block="true"]')].map((node)=>String(node.textContent||'')):[];
    const expectedStructure=(${normalizeNeteaseExpectedFormat.toString()})(count(source)); const actualStructure=bodyEl instanceof HTMLElement?count(bodyEl,true):{headings:0,lists:0,quotes:0,dividers:0,images:0};
    const labels={headings:'小标题',lists:'列表',quotes:'引用',dividers:'分隔线',images:'正文图片'};
    const degradedBlocks=Object.keys(expectedStructure).filter(key=>actualStructure[key]<expectedStructure[key]).map(key=>labels[key]);
    const expectedBlockCount=(${countNeteaseExpectedBlocks.toString()})([...source.children].map((node)=>({tag:node.tagName.toLowerCase(),text:String(node.textContent||'').trim(),listItemCount:(node.tagName==='UL'||node.tagName==='OL')?node.querySelectorAll(':scope > li').length:0})));
    const actualBlockCount=bodyEl instanceof HTMLElement?bodyEl.querySelectorAll('[data-block="true"]').length:0;
    const contentVerification=verifyNeteaseContentBlocks(actualBlocks,expectedBlocks);
    return {titleFilled:actualTitle===normalize(${JSON.stringify(title)}),bodyFilled:Boolean(bodyEl)&&contentVerification!=='mismatch',expectedBlockCount,actualBlockCount,blockVerification:{expectedCount:expectedBlocks.length,actualCount:actualBlocks.length,mismatchIndex:neteaseBlockMismatchIndex(actualBlocks,expectedBlocks)},contentVerification,formatVerification:{expected:expectedStructure,actual:actualStructure,preserved:degradedBlocks.length===0,degradedBlocks}};
  })()`);
  for (let attempt = 0; (!verified.titleFilled || !verified.bodyFilled) && attempt < 2; attempt += 1) {
    if (!verified.bodyFilled) await setBody();
    if (!verified.titleFilled) await setTitle();
    await delay(1_200 + attempt * 600);
    verified = await webContents.executeJavaScript(`(() => {
      const normalize=(v)=>String(v||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const parser=document.createElement('div'); parser.innerHTML=${JSON.stringify(html)}; const expected=normalize(parser.innerText||parser.textContent||'');
      const titleEl=document.querySelector('textarea.netease-textarea,textarea[placeholder*="标题"]');
      const bodyEl=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      const actualTitle=titleEl instanceof HTMLTextAreaElement?normalize(titleEl.value):''; const actualBody=bodyEl instanceof HTMLElement?normalize([...bodyEl.querySelectorAll('[data-text="true"]')].map((node)=>String(node.textContent||'')).join('\\n')):'';
    const compact=(value)=>normalize(value).replace(/[\\s\\-•·]/g,'');
      const contentMatchesExpected=${contentMatchesExpected.toString()};
      const neteaseBlockTextsMatch=${neteaseBlockTextsMatch.toString()};
      const neteaseBlockMismatchIndex=${neteaseBlockMismatchIndex.toString()};
      const verifyNeteaseContentBlocks=${verifyNeteaseContentBlocks.toString()};
      const count=(root,actual=false)=>({headings:root.querySelectorAll(actual?'h2,h3,h4,h5,h6':'h2,h3').length,lists:root.querySelectorAll('ul,ol').length,quotes:root.querySelectorAll('blockquote').length,dividers:root.querySelectorAll('hr').length,images:root.querySelectorAll('img').length});
      const source=document.createElement('div'); source.innerHTML=${JSON.stringify(html)};
      const expectedBlocks=[...source.children].flatMap((node)=>['ul','ol'].includes(node.tagName.toLowerCase())?[...node.querySelectorAll(':scope > li')].map((item)=>String(item.textContent||'')):(node.tagName.toLowerCase()==='hr'?[]:[String(node.textContent||'')]));
      const actualBlocks=bodyEl instanceof HTMLElement?[...bodyEl.querySelectorAll('[data-block="true"]')].map((node)=>String(node.textContent||'')):[];
      const expectedStructure=(${normalizeNeteaseExpectedFormat.toString()})(count(source)); const actualStructure=bodyEl instanceof HTMLElement?count(bodyEl,true):{headings:0,lists:0,quotes:0,dividers:0,images:0};
      const labels={headings:'小标题',lists:'列表',quotes:'引用',dividers:'分隔线',images:'正文图片'};
      const degradedBlocks=Object.keys(expectedStructure).filter(key=>actualStructure[key]<expectedStructure[key]).map(key=>labels[key]);
      const expectedBlockCount=(${countNeteaseExpectedBlocks.toString()})([...source.children].map((node)=>({tag:node.tagName.toLowerCase(),text:String(node.textContent||'').trim(),listItemCount:(node.tagName==='UL'||node.tagName==='OL')?node.querySelectorAll(':scope > li').length:0})));
      const actualBlockCount=bodyEl instanceof HTMLElement?bodyEl.querySelectorAll('[data-block="true"]').length:0;
      const contentVerification=verifyNeteaseContentBlocks(actualBlocks,expectedBlocks);
      return {titleFilled:actualTitle===normalize(${JSON.stringify(title)}),bodyFilled:Boolean(bodyEl)&&contentVerification!=='mismatch',expectedBlockCount,actualBlockCount,blockVerification:{expectedCount:expectedBlocks.length,actualCount:actualBlocks.length,mismatchIndex:neteaseBlockMismatchIndex(actualBlocks,expectedBlocks)},contentVerification,formatVerification:{expected:expectedStructure,actual:actualStructure,preserved:degradedBlocks.length===0,degradedBlocks}};
    })()`);
  }
  return verified;
}

async function setFileInput(webContents: WebContents, filePath: string): Promise<boolean> {
  const debuggerApi = webContents.debugger; const attached = !debuggerApi.isAttached(); if (attached) debuggerApi.attach('1.3');
  try {
    // Querying the entire DOM tree can stall Chromium's compositor on large editor pages.
    const doc = await debuggerApi.sendCommand('DOM.getDocument', { depth: 0, pierce: true }) as { root: { nodeId: number } };
    const inputs = await debuggerApi.sendCommand('DOM.querySelectorAll', {
      nodeId: doc.root.nodeId,
      selector: '.ne-dialog input[type=file],[role=dialog] input[type=file],[class*=modal] input[type=file],input[type=file]',
    }) as { nodeIds: number[] };
    if (!inputs.nodeIds?.length) return false;
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: inputs.nodeIds.at(-1) });
    return true;
  } finally { if (attached && debuggerApi.isAttached()) debuggerApi.detach(); }
}

async function bodyImageCount(webContents: WebContents): Promise<number> {
  return await webContents.executeJavaScript(`document.querySelectorAll('.public-DraftEditor-content .rich-editor-image-container img').length`);
}

function editorEndSelectionScript(): string {
  return `(() => {
    const editor=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    const textNodes=[...editor.querySelectorAll('[data-text="true"]')]
      .map((element)=>element.firstChild||element)
      .filter((node)=>String(node.textContent||'').trim());
    const target=textNodes.at(-1)||editor.querySelector('[data-block="true"]:last-child')||editor;
    editor.scrollIntoView({block:'center',inline:'nearest'});
    editor.focus({preventScroll:true});
    const range=document.createRange(); range.selectNodeContents(target); range.collapse(false);
    const selection=window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange',{bubbles:true}));
    return document.activeElement===editor&&selection?.rangeCount===1&&selection.getRangeAt(0).collapsed;
  })()`;
}

export function buildNeteaseEditorEndSelectionScriptForTest(): string {
  return editorEndSelectionScript();
}

async function clickDomSelector(webContents: WebContents, selector: string): Promise<boolean> {
  const scrolled = await webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  })()`);
  if (!scrolled) return false;
  await delay(350);
  const point = await webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) return false;
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await delay(120);
  await cdpClick(webContents, { x, y });
  return true;
}

async function clickVisibleText(webContents: WebContents, selectors: string, text: string): Promise<boolean> {
  const findScript = `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const element = [...document.querySelectorAll(${JSON.stringify(selectors)})].filter((candidate) => {
      if (!(candidate instanceof HTMLElement) || normalize(candidate.textContent) !== ${JSON.stringify(text)}) return false;
      const rect = candidate.getBoundingClientRect(); const style = getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).sort((left, right) => {
      const a = left.getBoundingClientRect(); const b = right.getBoundingClientRect();
      return (a.width * a.height) - (b.width * b.height);
    })[0];
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  const initial = await webContents.executeJavaScript(findScript);
  if (!initial) return false;
  await webContents.executeJavaScript(`(() => { const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim(); const element=[...document.querySelectorAll(${JSON.stringify(selectors)})].filter(candidate=>candidate instanceof HTMLElement&&normalize(candidate.textContent)===${JSON.stringify(text)}).sort((left,right)=>{const a=left.getBoundingClientRect();const b=right.getBoundingClientRect();return(a.width*a.height)-(b.width*b.height);})[0]; if(!(element instanceof HTMLElement))return false; element.scrollIntoView({block:'center',inline:'nearest'}); return true; })()`);
  await delay(350);
  const point = await webContents.executeJavaScript(findScript);
  if (!point) return false;
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await delay(120);
  await cdpClick(webContents, { x, y });
  return true;
}

async function insertBodyImage(webContents: WebContents, filePath: string): Promise<boolean> {
  if (!(await access(filePath).then(() => true).catch(() => false))) throw new Error(`COVER_NOT_FOUND: 找不到封面文件 ${filePath}`);
  const step = async <T>(code: string, action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) { throw new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const caretPlaced = await step('NETEASE_IMAGE_CARET_FAILED', () => webContents.executeJavaScript(editorEndSelectionScript()));
  if (!caretPlaced) throw new Error('NETEASE_IMAGE_CARET_FAILED: 无法把图片插入点定位到正文末尾');
  await delay(250);
  const point = await step('NETEASE_IMAGE_TOOL_LOOKUP_FAILED', () => webContents.executeJavaScript(`(() => { const visible=${visibleScript()}; const e=[...document.querySelectorAll('button.rich-editor-panel-item')].find(e=>visible(e)&&e.querySelector('img[src*="icon_image"]')); if(!e)return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`));
  if (!point) return false;
  await cdpClick(webContents, { x: Math.round(point.x), y: Math.round(point.y) });
  await delay(900);
  const applied = await step('NETEASE_IMAGE_FILE_SET_FAILED', () => setFileInput(webContents, filePath));
  if (!applied) return false;
  // Upload confirmation can take longer on Windows or when the platform
  // resizes/transcodes the image. Keep polling the same editor instead of
  // treating a transiently missing preview as a failed upload.
  for (let i = 0; i < 60; i += 1) {
    const ready = await step('NETEASE_IMAGE_CONFIRM_READY_FAILED', () => webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.ne-modal-footer button:last-child');
      const text = String(button ? button.textContent : '').replace(/\\s+/g, '');
      return button instanceof HTMLButtonElement && !button.disabled && text.startsWith('确定(') && text !== '确定(0)';
    })()`));
    if (ready) break;
    await delay(400);
  }
  if (!await step('NETEASE_IMAGE_CONFIRM_CLICK_FAILED', () => clickDomSelector(webContents, '.ne-modal-footer button:last-child'))) return false;
  for (let i=0;i<30;i+=1) {
    await delay(700);
    try {
      if (await bodyImageCount(webContents) >= 1) return true;
    } catch (error) {
      // Windows may replace the renderer context while the uploaded image is
      // committed. Re-read the live editor instead of reporting permission loss.
      if (!isTransientPageError(error)) throw new Error(`NETEASE_IMAGE_VERIFY_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return false;
}

async function applyOptions(webContents: WebContents): Promise<{ autoCoverSelected:boolean; aiDeclarationFound:boolean; aiDeclarationSelected:boolean }> {
  let autoCoverSelected = await webContents.executeJavaScript(`(() => { const input=document.querySelector('input[type="radio"][value="auto"]'); return input instanceof HTMLInputElement&&input.checked; })()`);
  if (!autoCoverSelected) {
    await clickDomSelector(webContents, 'input[type="radio"][value="auto"]');
    for (let i = 0; i < 15 && !autoCoverSelected; i += 1) {
      await delay(300);
      autoCoverSelected = await webContents.executeJavaScript(`(() => { const input=document.querySelector('input[type="radio"][value="auto"]'); return input instanceof HTMLInputElement&&input.checked; })()`);
    }
  }

  let declaration = await webContents.executeJavaScript(`(() => { const button=document.querySelector('button.box-trigger.custom-switcher'); if(!(button instanceof HTMLElement))return {found:false,enabled:false}; const enabled=button.getAttribute('value')==='true'||/active|checked|open/.test(String(button.className||'')); return {found:true,enabled}; })()`);
  if (declaration.found && !declaration.enabled) {
    await clickDomSelector(webContents, 'button.box-trigger.custom-switcher');
    for (let i = 0; i < 15 && !declaration.enabled; i += 1) {
      await delay(300);
      declaration = await webContents.executeJavaScript(`(() => { const button=document.querySelector('button.box-trigger.custom-switcher'); if(!(button instanceof HTMLElement))return {found:false,enabled:false}; return {found:true,enabled:button.getAttribute('value')==='true'||/active|checked|open/.test(String(button.className||''))}; })()`);
    }
  }
  const dropdown = declaration.enabled && await clickVisibleText(webContents, 'button,[role="button"],div,span', '选择声明内容');
  if (dropdown) await delay(500);
  const optionClicked = dropdown && await clickVisibleText(webContents, '[role="option"],li,button,div,span', '内容由AI生成');
  if (optionClicked) await delay(700);
  const aiDeclarationSelected = await webContents.executeJavaScript(`(() => { const norm=(v)=>String(v||'').replace(/\\s+/g,' ').trim(); const toggle=document.querySelector('button.box-trigger.custom-switcher'); if(!(toggle instanceof HTMLElement))return false; return (toggle.getAttribute('value')==='true'||/active|checked|open/.test(String(toggle.className||'')))&&[...document.querySelectorAll('body *')].some(e=>norm(e.textContent)==='内容由AI生成'); })()`);
  return { autoCoverSelected, aiDeclarationFound: Boolean(declaration.found), aiDeclarationSelected };
}

export async function fillNeteaseDraft(webContents: WebContents, title: string, html: string, coverPath: string): Promise<NeteaseDraftFillResult> {
  const runStage = async <T>(code: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${code}: ${message}`);
    }
  };
  await runStage('NETEASE_EDITOR_FAILED', () => ensureEditor(webContents));
  const content = await runStage('NETEASE_TEXT_FILL_FAILED', () => fillText(webContents, title, html));
  if (!content.titleFilled || !content.bodyFilled) {
    const verification = content.blockVerification;
    throw new Error(`NETEASE_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}, blocks=${verification?.actualCount ?? -1}/${verification?.expectedCount ?? -1}, mismatch=${verification?.mismatchIndex ?? 'none'}`);
  }
  if (process.platform === 'win32' && classifyDraftBlockCount(content.expectedBlockCount || 0, content.actualBlockCount || 0) !== 'match') throw new Error(`NETEASE_PARAGRAPH_STRUCTURE_FAILED: 正文段落结构不一致，expected=${content.expectedBlockCount}, actual=${content.actualBlockCount}`);
  const formatWarnings = [
    ...(content.formatVerification.preserved ? [] : content.formatVerification.degradedBlocks),
    ...(content.contentVerification === 'equivalent_text' ? ['编辑器结构已归一化验证，正文文本完整保留'] : []),
  ];
  const bodyImageInserted = await runStage('NETEASE_IMAGE_FLOW_FAILED', () => insertBodyImage(webContents, coverPath));
  if (!bodyImageInserted) throw new Error('NETEASE_BODY_IMAGE_FAILED: 正文图片上传或确认未完成');
  const options = await runStage('NETEASE_OPTIONS_FAILED', () => applyOptions(webContents));
  const publishButtonDetected = await runStage('NETEASE_PUBLISH_BUTTON_CHECK_FAILED', () => webContents.executeJavaScript(`(() => { const button=document.querySelector('button.primary_button'); return button instanceof HTMLButtonElement&&!button.disabled&&!button.hasAttribute('disabled'); })()`));
  await delay(500);
  return { ...content, ...(formatWarnings.length ? { formatWarnings } : {}), bodyImageInserted, ...options, publishButtonDetected, url: webContents.getURL() };
}
