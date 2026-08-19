import { access } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { contentMatchesExpected } from './content-verification.js';
import { resumeVisibleDraft } from './editor-draft.js';

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

async function ensureEditor(webContents: WebContents): Promise<void> {
  // The session layer has already loaded a fresh page for a new platform job.
  // Reloading this hash-routed editor a second time can SIGTRAP Electron on macOS.
  // Existing content is safely replaced through Draft.js selection in fillText.
  if (!webContents.getURL().includes('article-publish')) {
    await webContents.loadURL(PUBLISH_URL);
  }
  const deadline = Date.now() + 120_000;
  let transientFailures = 0;
  let draftChecked = false;
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
    if (readyStreak >= 3 && !draftChecked) {
      draftChecked = true;
      if (await resumeVisibleDraft(webContents)) {
        readyStreak = 0;
        await delay(1_200);
        continue;
      }
    }
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
    // Draft.js only honours a selection made through Chromium's real input
    // pipeline. A DOM Range looks selected to the page, but paste appends to
    // the existing Draft state and every retry creates a duplicate article.
    const editorState = await webContents.executeJavaScript(`(() => {
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const contentMatchesExpected=${contentMatchesExpected.toString()};
      const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      if (!(element instanceof HTMLElement)) return null;
      if (contentMatchesExpected(element.innerText||element.textContent||'', ${JSON.stringify(bodyText)})) return {alreadyMatches:true,point:null};
      element.scrollIntoView({block:'center',inline:'nearest'});
      const rect=element.getBoundingClientRect();
      return {alreadyMatches:false,point:{x:rect.left+Math.min(80,rect.width/2),y:rect.top+Math.min(28,rect.height/2)}};
    })()`);
    if (editorState?.alreadyMatches) return true;
    const point = editorState?.point;
    if (!point) return false;
    webContents.focus();
    webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y)});
    await delay(100);
    webContents.sendInputEvent({type:'mouseDown',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    webContents.sendInputEvent({type:'mouseUp',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    await delay(250);
    const modifiers: Array<'meta' | 'control'> = [process.platform === 'darwin' ? 'meta' : 'control'];
    webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers});
    webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers});
    await delay(180);
    const selectedAll = await webContents.executeJavaScript(`(() => {
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      const selection=window.getSelection();
      return element instanceof HTMLElement && Boolean(selection) && normalize(selection.toString())===normalize(element.innerText||element.textContent||'');
    })()`);
    if (!selectedAll) return false;
    return await webContents.executeJavaScript(`(async () => {
      const sourceHtml=${JSON.stringify(html)};
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const contentMatchesExpected=${contentMatchesExpected.toString()};
      const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      if (!(element instanceof HTMLElement)) return false;
      const parser=document.createElement('div'); parser.innerHTML=sourceHtml;
      const expectedStructure={headings:parser.querySelectorAll('h2,h3').length,lists:parser.querySelectorAll('ul,ol').length,quotes:parser.querySelectorAll('blockquote').length,dividers:parser.querySelectorAll('hr').length,images:parser.querySelectorAll('img').length};
      const plainText=normalize(parser.innerText||parser.textContent||'');
      try {
        const transfer=new DataTransfer();
        transfer.setData('text/html',sourceHtml);
        transfer.setData('text/plain',plainText);
        element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
      } catch {}
      await new Promise((resolve)=>setTimeout(resolve,1200));
      const actualText=element.innerText||element.textContent||'';
      if (contentMatchesExpected(actualText, ${JSON.stringify(bodyText)})) return true;
      // A plain paragraph can safely use the editor command as a fallback. Never
      // mutate Draft.js innerHTML: doing so desynchronizes React state and can blank the page.
      if (!Object.values(expectedStructure).some(Boolean)) {
        try { document.execCommand('insertText',false,plainText); } catch {}
        await new Promise((resolve)=>setTimeout(resolve,700));
        return contentMatchesExpected(element.innerText||element.textContent, ${JSON.stringify(bodyText)});
      }
      // Draft.js may cancel a synthetic paste event after it has already
      // committed the content. The DOM/state verification is authoritative;
      // never retry solely because dispatchEvent returned false.
      return contentMatchesExpected(element.innerText||element.textContent, ${JSON.stringify(bodyText)});
    })()`);
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
    const actualTitle=titleEl instanceof HTMLTextAreaElement?normalize(titleEl.value):''; const actualBody=bodyEl instanceof HTMLElement?normalize(bodyEl.innerText||bodyEl.textContent):'';
    const compact=(value)=>normalize(value).replace(/[\\s\\-•·]/g,'');
    const contentMatchesExpected=${contentMatchesExpected.toString()};
    const count=(root)=>({headings:root.querySelectorAll('h2,h3').length,lists:root.querySelectorAll('ul,ol').length,quotes:root.querySelectorAll('blockquote').length,dividers:root.querySelectorAll('hr').length,images:root.querySelectorAll('img').length});
    const source=document.createElement('div'); source.innerHTML=${JSON.stringify(html)};
    const expectedStructure=count(source); const actualStructure=bodyEl instanceof HTMLElement?count(bodyEl):{headings:0,lists:0,quotes:0,dividers:0,images:0};
    const labels={headings:'小标题',lists:'列表',quotes:'引用',dividers:'分隔线',images:'正文图片'};
    const degradedBlocks=Object.keys(expectedStructure).filter(key=>actualStructure[key]<expectedStructure[key]).map(key=>labels[key]);
    return {titleFilled:actualTitle===normalize(${JSON.stringify(title)}),bodyFilled:Boolean(bodyEl)&&contentMatchesExpected(actualBody,expected),formatVerification:{expected:expectedStructure,actual:actualStructure,preserved:degradedBlocks.length===0,degradedBlocks}};
  })()`);
  for (let attempt = 0; (!verified.titleFilled || !verified.bodyFilled || !verified.formatVerification.preserved) && attempt < 2; attempt += 1) {
    if (!verified.bodyFilled || !verified.formatVerification.preserved) await setBody();
    if (!verified.titleFilled) await setTitle();
    await delay(1_200 + attempt * 600);
    verified = await webContents.executeJavaScript(`(() => {
      const normalize=(v)=>String(v||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const parser=document.createElement('div'); parser.innerHTML=${JSON.stringify(html)}; const expected=normalize(parser.innerText||parser.textContent||'');
      const titleEl=document.querySelector('textarea.netease-textarea,textarea[placeholder*="标题"]');
      const bodyEl=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      const actualTitle=titleEl instanceof HTMLTextAreaElement?normalize(titleEl.value):''; const actualBody=bodyEl instanceof HTMLElement?normalize(bodyEl.innerText||bodyEl.textContent):'';
    const compact=(value)=>normalize(value).replace(/[\\s\\-•·]/g,'');
      const contentMatchesExpected=${contentMatchesExpected.toString()};
      const count=(root)=>({headings:root.querySelectorAll('h2,h3').length,lists:root.querySelectorAll('ul,ol').length,quotes:root.querySelectorAll('blockquote').length,dividers:root.querySelectorAll('hr').length,images:root.querySelectorAll('img').length});
      const source=document.createElement('div'); source.innerHTML=${JSON.stringify(html)};
      const expectedStructure=count(source); const actualStructure=bodyEl instanceof HTMLElement?count(bodyEl):{headings:0,lists:0,quotes:0,dividers:0,images:0};
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

async function bodyImageExists(webContents: WebContents): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => { const imgs=[...document.querySelectorAll('.public-DraftEditor-content img')]; return imgs.some(i=>{const r=i.getBoundingClientRect(); return r.width>20&&r.height>20&&i.complete&&i.naturalWidth>0;}); })()`);
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
  for (let i = 0; i < 30; i += 1) {
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
      if (await bodyImageExists(webContents)) return true;
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
