import { access } from 'node:fs/promises';
import type { WebContents } from 'electron';

const PUBLISH_URL = 'https://mp.163.com/subscribe_v4/index.html#/article-publish';

export interface NeteaseDraftFillResult {
  titleFilled: boolean;
  bodyFilled: boolean;
  bodyImageInserted: boolean;
  autoCoverSelected: boolean;
  aiDeclarationFound: boolean;
  aiDeclarationSelected: boolean;
  publishButtonDetected: boolean;
  url: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const normalize = (value: unknown) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

function visibleScript(): string {
  return `(element) => element instanceof HTMLElement && (() => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })()`;
}

async function ensureEditor(webContents: WebContents): Promise<void> {
  // Recreate the Draft.js editor for every job. Reusing the previous mounted instance after an
  // image upload can leave stale React selection state and make the next overwrite crash the page.
  if (webContents.getURL().includes('article-publish')) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('NETEASE_RELOAD_TIMEOUT: 网易号发布页重新加载超时')); }, 90_000);
      const cleanup = () => { clearTimeout(timeout); webContents.removeListener('did-stop-loading', done); };
      const done = () => { cleanup(); resolve(); };
      webContents.once('did-stop-loading', done);
      webContents.reload();
    });
  } else {
    await webContents.loadURL(PUBLISH_URL);
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await webContents.executeJavaScript(`(() => {
      const visible = ${visibleScript()};
      const text = String(document.body ? document.body.innerText : '');
      const fields = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
      return { ready: fields.length >= 2, login: /登录|扫码|验证码|安全验证|账号异常/.test(text) && fields.length < 2 };
    })()`);
    if (state.login) throw new Error('NETEASE_LOGIN_REQUIRED: 请在当前桌面端完成网易号登录');
    if (state.ready) return;
    await delay(800);
  }
  throw new Error('NETEASE_EDITOR_NOT_READY: 网易号图文编辑器 120 秒内未就绪');
}

async function fillText(webContents: WebContents, title: string, html: string): Promise<{ titleFilled: boolean; bodyFilled: boolean }> {
  const bodyText = await webContents.executeJavaScript(`(() => { const parser=document.createElement('div'); parser.innerHTML=${JSON.stringify(html)}; return String(parser.innerText||parser.textContent||'').replace(/\\u00a0/g,' ').trim(); })()`);
  const setTitle = async (): Promise<boolean> => {
    return await webContents.executeJavaScript(`(() => {
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
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
    const point = await webContents.executeJavaScript(`(() => {
      const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({block:'center',inline:'nearest'});
      const rect=element.getBoundingClientRect();
      return {x:rect.left+Math.min(80,rect.width/2),y:rect.top+Math.min(28,rect.height/2)};
    })()`);
    if (!point) return false;
    webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y)});
    await delay(100);
    webContents.sendInputEvent({type:'mouseDown',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    webContents.sendInputEvent({type:'mouseUp',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    await delay(300);
    const modifiers: Array<'meta' | 'control'> = [process.platform === 'darwin' ? 'meta' : 'control'];
    webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers});
    webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers});
    await delay(180);
    const selectedAll = await webContents.executeJavaScript(`(() => {
      const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      if (!(element instanceof HTMLElement)) return false;
      const selection=window.getSelection();
      return Boolean(selection)&&normalize(selection.toString())===normalize(element.innerText||element.textContent);
    })()`);
    if (!selectedAll) return false;
    webContents.insertText(bodyText);
    await delay(900);
    return await webContents.executeJavaScript(`(() => { const normalize=(value)=>String(value||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim(); const element=document.querySelector('.public-DraftEditor-content[contenteditable="true"]'); return element instanceof HTMLElement&&normalize(element.innerText||element.textContent)===normalize(${JSON.stringify(bodyText)}); })()`);
  };
  if (!await setTitle()) return { titleFilled: false, bodyFilled: false };
  await delay(700);
  if (!await setBody()) return { titleFilled: false, bodyFilled: false };
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
  return await webContents.executeJavaScript(`(() => {
    const normalize=(v)=>String(v||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
    const parser=document.createElement('div'); parser.innerHTML=${JSON.stringify(html)}; const expected=normalize(parser.innerText||parser.textContent||'');
    const titleEl=document.querySelector('textarea.netease-textarea,textarea[placeholder*="标题"]');
    const bodyEl=document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
    const actualTitle=titleEl instanceof HTMLTextAreaElement?normalize(titleEl.value):''; const actualBody=bodyEl instanceof HTMLElement?normalize(bodyEl.innerText||bodyEl.textContent):'';
    return {titleFilled:actualTitle===normalize(${JSON.stringify(title)}),bodyFilled:Boolean(bodyEl)&&actualBody===expected};
  })()`);
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
  for (let i=0;i<24;i+=1) { await delay(700); const found = await step('NETEASE_IMAGE_VERIFY_FAILED', () => webContents.executeJavaScript(`(() => { const imgs=[...document.querySelectorAll('.public-DraftEditor-content img')]; return imgs.some(i=>{const r=i.getBoundingClientRect(); return r.width>20&&r.height>20;}); })()`)); if (found) return true; }
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

  let declaration = await webContents.executeJavaScript(`(() => { const button=document.querySelector('button.custom-switcher'); if(!(button instanceof HTMLElement))return {found:false,enabled:false}; const enabled=button.getAttribute('value')==='true'||/active|checked|open/.test(String(button.className||'')); return {found:true,enabled}; })()`);
  if (declaration.found && !declaration.enabled) {
    await clickDomSelector(webContents, 'button.custom-switcher');
    for (let i = 0; i < 15 && !declaration.enabled; i += 1) {
      await delay(300);
      declaration = await webContents.executeJavaScript(`(() => { const button=document.querySelector('button.custom-switcher'); if(!(button instanceof HTMLElement))return {found:false,enabled:false}; return {found:true,enabled:button.getAttribute('value')==='true'||/active|checked|open/.test(String(button.className||''))}; })()`);
    }
  }
  const dropdown = declaration.enabled && await clickVisibleText(webContents, 'button,[role="button"],div,span', '选择声明内容');
  if (dropdown) await delay(500);
  const optionClicked = dropdown && await clickVisibleText(webContents, '[role="option"],li,button,div,span', '内容由AI生成');
  if (optionClicked) await delay(700);
  const aiDeclarationSelected = await webContents.executeJavaScript(`(() => { const norm=(v)=>String(v||'').replace(/\\s+/g,' ').trim(); const toggle=document.querySelector('button.custom-switcher'); if(!(toggle instanceof HTMLElement))return false; return (toggle.getAttribute('value')==='true'||/active|checked|open/.test(String(toggle.className||'')))&&[...document.querySelectorAll('body *')].some(e=>norm(e.textContent)==='内容由AI生成'); })()`);
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
  const bodyImageInserted = await runStage('NETEASE_IMAGE_FLOW_FAILED', () => insertBodyImage(webContents, coverPath));
  if (!bodyImageInserted) throw new Error('NETEASE_BODY_IMAGE_FAILED: 正文图片上传或确认未完成');
  const options = await runStage('NETEASE_OPTIONS_FAILED', () => applyOptions(webContents));
  const publishButtonDetected = await runStage('NETEASE_PUBLISH_BUTTON_CHECK_FAILED', () => webContents.executeJavaScript(`(() => { const button=document.querySelector('button.primary_button'); return button instanceof HTMLButtonElement&&!button.disabled&&!button.hasAttribute('disabled'); })()`));
  await delay(500);
  return { ...content, bodyImageInserted, ...options, publishButtonDetected, url: webContents.getURL() };
}
