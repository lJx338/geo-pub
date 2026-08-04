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
  if (!webContents.getURL().includes('article-publish')) await webContents.loadURL(PUBLISH_URL);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await webContents.executeJavaScript(`(() => {
      const visible = ${visibleScript()};
      const text = String(document.body?.innerText || '');
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
  const state = await webContents.executeJavaScript(`(() => {
    const visible = ${visibleScript()};
    const normalize = (v) => String(v || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const meta = (e) => normalize([e.getAttribute('placeholder'),e.getAttribute('aria-label'),e.getAttribute('data-placeholder'),e.className].join(' '));
    const fields = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
    const titleEl = fields.map(e => ({e, score: (meta(e).includes('标题') ? 500 : 0) + (e.tagName === 'INPUT' ? 100 : 0)})).sort((a,b)=>b.score-a.score)[0]?.e;
    const bodyEl = fields.filter(e=>e!==titleEl).map(e=>({e, score:(meta(e).includes('正文')||meta(e).includes('内容')?500:0)+(e.getBoundingClientRect().height>160?120:0)+(e.getAttribute('contenteditable')==='true'?80:0)})).sort((a,b)=>b.score-a.score)[0]?.e;
    const requestedTitle = ${JSON.stringify(title)}; const requestedHtml = ${JSON.stringify(html)};
    const setValue = (e,v) => { const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value')?.set?.call(e,v); e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:v})); e.dispatchEvent(new Event('change',{bubbles:true})); };
    if (titleEl instanceof HTMLInputElement || titleEl instanceof HTMLTextAreaElement) setValue(titleEl, requestedTitle); else if (titleEl instanceof HTMLElement) { titleEl.focus(); titleEl.replaceChildren(document.createTextNode(requestedTitle)); titleEl.dispatchEvent(new InputEvent('input',{bubbles:true})); }
    if (bodyEl instanceof HTMLInputElement || bodyEl instanceof HTMLTextAreaElement) setValue(bodyEl, requestedHtml.replace(/<[^>]+>/g,' '));
    else if (bodyEl instanceof HTMLElement) { bodyEl.focus(); const range=document.createRange(); range.selectNodeContents(bodyEl); const sel=getSelection(); sel?.removeAllRanges(); sel?.addRange(range); document.execCommand('insertHTML',false,requestedHtml); bodyEl.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'})); }
    const actualTitle = normalize(titleEl instanceof HTMLInputElement || titleEl instanceof HTMLTextAreaElement ? titleEl.value : titleEl?.textContent);
    const actualBody = normalize(bodyEl instanceof HTMLInputElement || bodyEl instanceof HTMLTextAreaElement ? bodyEl.value : bodyEl?.innerText || bodyEl?.textContent);
    return { titleFilled: actualTitle === normalize(requestedTitle), bodyFilled: actualBody.length >= Math.min(20, normalize(requestedHtml.replace(/<[^>]+>/g,' ')).length) };
  })()`);
  await delay(1200);
  return state;
}

async function setFileInput(webContents: WebContents, filePath: string): Promise<boolean> {
  const debuggerApi = webContents.debugger; const attached = !debuggerApi.isAttached(); if (attached) debuggerApi.attach('1.3');
  try {
    const doc = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } };
    const inputs = await debuggerApi.sendCommand('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }) as { nodeIds: number[] };
    if (!inputs.nodeIds?.length) return false;
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: inputs.nodeIds[0] });
    return true;
  } finally { if (attached && debuggerApi.isAttached()) debuggerApi.detach(); }
}

async function insertBodyImage(webContents: WebContents, filePath: string): Promise<boolean> {
  if (!(await access(filePath).then(() => true).catch(() => false))) throw new Error(`COVER_NOT_FOUND: 找不到封面文件 ${filePath}`);
  let applied = await setFileInput(webContents, filePath);
  if (!applied) {
    const point = await webContents.executeJavaScript(`(() => { const visible=${visibleScript()}; const e=[...document.querySelectorAll('button,[role="button"],span,div')].filter(visible).find(e=>/图片|插图|上传图片/.test(String(e.textContent||e.getAttribute('aria-label')||''))); if(!e)return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    if (point) { webContents.sendInputEvent({ type:'mouseDown', x:Math.round(point.x), y:Math.round(point.y), button:'left', clickCount:1 }); webContents.sendInputEvent({ type:'mouseUp', x:Math.round(point.x), y:Math.round(point.y), button:'left', clickCount:1 }); await delay(800); applied = await setFileInput(webContents, filePath); }
  }
  if (!applied) return false;
  for (let i=0;i<24;i+=1) { await delay(700); const found = await webContents.executeJavaScript(`(() => { const imgs=[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect(); const s=getComputedStyle(i); return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden;}); return imgs.some(i=>i.closest('[contenteditable="true"],[role="textbox"],.ql-editor,.ProseMirror')); })()`); if (found) return true; }
  return false;
}

async function applyOptions(webContents: WebContents): Promise<{ autoCoverSelected:boolean; aiDeclarationFound:boolean; aiDeclarationSelected:boolean }> {
  const result = await webContents.executeJavaScript(`(() => {
    const visible=${visibleScript()}; const norm=(v)=>String(v||'').replace(/\\s+/g,' ').trim();
    const auto=[...document.querySelectorAll('label,[role="radio"],button,span,div')].filter(visible).find(e=>norm(e.textContent)==='自动');
    let autoSelected=false; if(auto){ const root=auto.closest('label,[role="radio"],button')||auto; const input=root.querySelector?.('input'); autoSelected=(input instanceof HTMLInputElement&&input.checked)||root.getAttribute?.('aria-checked')==='true'||/checked|selected|active/.test(String(root.className||'')); if(!autoSelected) root.click(); }
    const declaration=[...document.querySelectorAll('label,span,div')].filter(visible).find(e=>/^声明[:：]?$/.test(norm(e.textContent)));
    const aiText='内容由AI生成'; let aiFound=false, aiSelected=false;
    if(declaration){ aiFound=true; let row=declaration.parentElement; for(let i=0;row&&i<6;i++,row=row.parentElement){ if(/声明/.test(norm(row.textContent))) { const t=[...row.querySelectorAll('button,[role="button"],input,span,div')].find(e=>visible(e)&&(/选择声明内容|内容由AI生成/.test(norm(e.textContent))||/声明/.test(String(e.getAttribute?.('aria-label')||'')))); if(t){ t.click(); break; } } } }
    return {autoSelected,aiFound};
  })()`);
  await delay(700);
  const aiState = await webContents.executeJavaScript(`(() => { const visible=${visibleScript()}; const norm=(v)=>String(v||'').replace(/\\s+/g,' ').trim(); const e=[...document.querySelectorAll('label,span,div,button,[role="option"]')].filter(visible).find(e=>norm(e.textContent)==='内容由AI生成'); if(e) e.click(); const selected=[...document.querySelectorAll('label,span,div')].filter(visible).some(e=>norm(e.textContent)==='内容由AI生成'&&/selected|checked|active/.test(String(e.className||''))); return {found:Boolean(e),selected}; })()`);
  return {autoCoverSelected:Boolean(result.autoSelected),aiDeclarationFound:Boolean(result.aiFound||aiState.found),aiDeclarationSelected:Boolean(aiState.selected)};
}

export async function fillNeteaseDraft(webContents: WebContents, title: string, html: string, coverPath: string): Promise<NeteaseDraftFillResult> {
  await ensureEditor(webContents);
  const content = await fillText(webContents, title, html);
  if (!content.titleFilled || !content.bodyFilled) throw new Error(`NETEASE_CONTENT_FILL_FAILED: title=${content.titleFilled}, body=${content.bodyFilled}`);
  const bodyImageInserted = await insertBodyImage(webContents, coverPath);
  const options = await applyOptions(webContents);
  const publishButtonDetected = await webContents.executeJavaScript(`(() => { const visible=${visibleScript()}; const n=(v)=>String(v||'').replace(/\\s+/g,' ').trim(); return [...document.querySelectorAll('button,[role="button"],a')].filter(visible).some(e=>n(e.textContent)==='发布'&&!e.hasAttribute('disabled')); })()`);
  await delay(500);
  return { ...content, bodyImageInserted, ...options, publishButtonDetected, url: webContents.getURL() };
}
