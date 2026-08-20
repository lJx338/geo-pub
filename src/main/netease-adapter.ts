import { access } from 'node:fs/promises';
import { clipboard, type WebContents } from 'electron';
import { contentMatchesExpected } from './content-verification.js';

const PUBLISH_URL = 'https://mp.163.com/subscribe_v4/index.html#/article-publish';

export interface NeteaseDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  formatVerification: {
    expected: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    actual: { headings: number; lists: number; quotes: number; dividers: number; images: number };
    preserved: boolean;
    degradedBlocks: string[];
  };
  bodyImageInserted: boolean;
  autoCoverSelected: boolean;
  aiDeclarationFound: boolean;
  aiDeclarationSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const normalize = (value: unknown) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

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
  webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y)});
  webContents.sendInputEvent({type:'mouseDown',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
  webContents.sendInputEvent({type:'mouseUp',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
  await delay(220);
  return true;
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
  formatVerification: NeteaseDraftFillResult['formatVerification'];
}> {
  const bodyText = await webContents.executeJavaScript(`(() => { const parser=document.createElement('div'); parser.innerHTML=${JSON.stringify(html)}; return String(parser.innerText||parser.textContent||'').replace(/\\u00a0/g,' ').trim(); })()`);
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
  const setBody = async (): Promise<boolean> => {
    const prepared = await webContents.executeJavaScript(`(() => {
      const contentMatchesExpected=${contentMatchesExpected.toString()};
      const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      if (!(element instanceof HTMLElement)) return null;
      const editableText=()=>[...element.querySelectorAll('[data-text="true"]')]
        .map((node)=>String(node.textContent||'')).join('\\n').trim();
      const currentText=editableText();
      const parser=document.createElement('div');
      parser.innerHTML=${JSON.stringify(html)};
      const expectedStructure={lists:parser.querySelectorAll('ul,ol').length,quotes:parser.querySelectorAll('blockquote').length};
      const actualStructure={lists:element.querySelectorAll('ul,ol').length,quotes:element.querySelectorAll('blockquote').length};
      const imageCount=element.querySelectorAll('.rich-editor-image-container img').length;
      const structureMatches=actualStructure.lists>=expectedStructure.lists&&actualStructure.quotes>=expectedStructure.quotes;
      if (contentMatchesExpected(currentText, ${JSON.stringify(bodyText)})&&structureMatches) return {alreadyMatches:true,point:null};
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const blocks=[...parser.children].flatMap((child)=>{
        const tag=child.tagName.toLowerCase();
        const text=normalize(child.textContent);
        if (tag==='p') return text?[{type:'paragraph',text,bold:Boolean(child.querySelector('strong,b'))}]:[];
        if (tag==='ul'||tag==='ol') return [{type:'list',ordered:tag==='ol',items:[...child.querySelectorAll(':scope > li')].map((item)=>normalize(item.textContent)).filter(Boolean)}];
        if (tag==='blockquote') return text?[{type:'quote',text}]:[];
        return text?[{type:'paragraph',text,bold:false}]:[];
      });
      const plainText=blocks.flatMap((block)=>block.type==='list'?block.items:[block.text]).join('\\n').trim();
      if (!plainText) return null;
      element.scrollIntoView({block:'center',inline:'nearest'});
      const rect=element.getBoundingClientRect();
      return {
        alreadyMatches:false,
        hasEditorContent:Boolean(currentText)||imageCount>0,
        blocks,
        plainText,
        point:{x:rect.left+Math.min(rect.width/2,320),y:rect.top+Math.min(rect.height/2,120)}
      };
    })()`);
    if (prepared?.alreadyMatches) return true;
    if (!prepared?.point || !prepared.plainText) return false;
    if (prepared.hasEditorContent) {
      throw new Error('NETEASE_EDITOR_NOT_EMPTY: 新建编辑会话仍包含旧草稿，已停止填充以避免重复内容');
    }

    // 网易和知乎都使用 Draft.js。只有 Chromium 的真实输入管线会同步
    // React ContentState；DOM Range、innerHTML 和合成 paste 都可能只改表象。
    webContents.focus();
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
      const previousClipboard={text:clipboard.readText(),html:clipboard.readHTML()};
      try {
        clipboard.write({text:prepared.plainText,html});
        webContents.paste();
        await delay(1_800);
        const pasted = await webContents.executeJavaScript(`(() => {
          const contentMatchesExpected=${contentMatchesExpected.toString()};
          const actual=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
          if (!(actual instanceof HTMLElement)) return {body:false,structure:false};
          const text=[...actual.querySelectorAll('[data-text="true"]')]
            .map((node)=>String(node.textContent||'')).join('\\n');
          const parser=document.createElement('div');parser.innerHTML=${JSON.stringify(html)};
          const expected={lists:parser.querySelectorAll('ul,ol').length,quotes:parser.querySelectorAll('blockquote').length};
          const observed={lists:actual.querySelectorAll('ul,ol').length,quotes:actual.querySelectorAll('blockquote').length};
          return {
            body:contentMatchesExpected(text,${JSON.stringify(bodyText)}),
            structure:observed.lists>=expected.lists&&observed.quotes>=expected.quotes,
          };
        })()`);
        if (pasted.body&&pasted.structure) return true;
        if (pasted.body) return false;
      } finally {
        clipboard.write(previousClipboard);
      }
      const inheritedHeading = await webContents.executeJavaScript(`(() => {
        const selection=window.getSelection();
        const node=selection?.anchorNode;
        const element=node instanceof Element?node:node?.parentElement;
        return Boolean(element?.closest('h1,h2,h3,h4,h5,h6'));
      })()`);
      if (inheritedHeading) await clickNeteaseEditorTool(webContents,'h5');
      const enter = async () => {
        await debuggerApi.sendCommand('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        await debuggerApi.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        await delay(100);
      };
      const insert = async (text: string) => {
        await debuggerApi.sendCommand('Input.insertText',{text});
        await delay(100);
      };
      const blocks = prepared.blocks as Array<
        | {type:'paragraph';text:string;bold:boolean}
        | {type:'list';items:string[];ordered:boolean}
        | {type:'quote';text:string}
      >;
      for (let index=0;index<blocks.length;index+=1) {
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
        const text=actual instanceof HTMLElement?[...actual.querySelectorAll('[data-text="true"]')]
          .map((node)=>String(node.textContent||'')).join('\\n'):'';
        return actual instanceof HTMLElement&&(${contentMatchesExpected.toString()})(text,${JSON.stringify(bodyText)});
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
    const count=(root,actual=false)=>({headings:root.querySelectorAll(actual?'h2,h3,h4,h5,h6':'h2,h3').length,lists:root.querySelectorAll('ul,ol').length,quotes:root.querySelectorAll('blockquote').length,dividers:root.querySelectorAll('hr').length,images:root.querySelectorAll('img').length});
    const source=document.createElement('div'); source.innerHTML=${JSON.stringify(html)};
    const expectedStructure=count(source); const actualStructure=bodyEl instanceof HTMLElement?count(bodyEl,true):{headings:0,lists:0,quotes:0,dividers:0,images:0};
    const labels={headings:'小标题',lists:'列表',quotes:'引用',dividers:'分隔线',images:'正文图片'};
    const degradedBlocks=Object.keys(expectedStructure).filter(key=>actualStructure[key]<expectedStructure[key]).map(key=>labels[key]);
    return {titleFilled:actualTitle===normalize(${JSON.stringify(title)}),bodyFilled:Boolean(bodyEl)&&contentMatchesExpected(actualBody,expected),formatVerification:{expected:expectedStructure,actual:actualStructure,preserved:degradedBlocks.length===0,degradedBlocks}};
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
      const count=(root,actual=false)=>({headings:root.querySelectorAll(actual?'h2,h3,h4,h5,h6':'h2,h3').length,lists:root.querySelectorAll('ul,ol').length,quotes:root.querySelectorAll('blockquote').length,dividers:root.querySelectorAll('hr').length,images:root.querySelectorAll('img').length});
      const source=document.createElement('div'); source.innerHTML=${JSON.stringify(html)};
      const expectedStructure=count(source); const actualStructure=bodyEl instanceof HTMLElement?count(bodyEl,true):{headings:0,lists:0,quotes:0,dividers:0,images:0};
      const labels={headings:'小标题',lists:'列表',quotes:'引用',dividers:'分隔线',images:'正文图片'};
      const degradedBlocks=Object.keys(expectedStructure).filter(key=>actualStructure[key]<expectedStructure[key]).map(key=>labels[key]);
      return {titleFilled:actualTitle===normalize(${JSON.stringify(title)}),bodyFilled:Boolean(bodyEl)&&expected.length>0&&contentMatchesExpected(actualBody,expected),formatVerification:{expected:expectedStructure,actual:actualStructure,preserved:degradedBlocks.length===0,degradedBlocks}};
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
  webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await delay(120);
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
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
  webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await delay(120);
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  return true;
}

async function insertBodyImage(webContents: WebContents, filePath: string): Promise<boolean> {
  if (!(await access(filePath).then(() => true).catch(() => false))) throw new Error(`COVER_NOT_FOUND: 找不到封面文件 ${filePath}`);
  const step = async <T>(code: string, action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) { throw new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const point = await step('NETEASE_IMAGE_TOOL_LOOKUP_FAILED', () => webContents.executeJavaScript(`(() => { const visible=${visibleScript()}; const e=[...document.querySelectorAll('button.rich-editor-panel-item')].find(e=>visible(e)&&e.querySelector('img[src*="icon_image"]')); if(!e)return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`));
  if (!point) return false;
  webContents.sendInputEvent({ type:'mouseDown', x:Math.round(point.x), y:Math.round(point.y), button:'left', clickCount:1 });
  webContents.sendInputEvent({ type:'mouseUp', x:Math.round(point.x), y:Math.round(point.y), button:'left', clickCount:1 });
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
      const count = await bodyImageCount(webContents);
      if (count >= 1) return true;
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
  if (!content.titleFilled || !content.bodyFilled) throw new Error(`NETEASE_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  if (!content.formatVerification.preserved) throw new Error(`NETEASE_FORMAT_DEGRADED: 网易号编辑器未保留${content.formatVerification.degradedBlocks.join('、')}`);
  const bodyImageInserted = await runStage('NETEASE_IMAGE_FLOW_FAILED', () => insertBodyImage(webContents, coverPath));
  if (!bodyImageInserted) throw new Error('NETEASE_BODY_IMAGE_FAILED: 正文图片上传或确认未完成');
  const options = await runStage('NETEASE_OPTIONS_FAILED', () => applyOptions(webContents));
  const publishButtonDetected = await runStage('NETEASE_PUBLISH_BUTTON_CHECK_FAILED', () => webContents.executeJavaScript(`(() => { const button=document.querySelector('button.primary_button'); return button instanceof HTMLButtonElement&&!button.disabled&&!button.hasAttribute('disabled'); })()`));
  await delay(500);
  return { ...content, bodyImageInserted, ...options, publishButtonDetected, url: webContents.getURL() };
}
