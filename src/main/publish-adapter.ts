import type { WebContents } from 'electron';
import type { Platform } from '../shared/protocol.js';
import { cdpClick } from './browser-automation-driver.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PublishResult {
  status: 'success' | 'action_required' | 'result_uncertain';
  platform: Platform;
  title: string;
  stage: string;
  message: string;
  url: string;
  pageText: string;
  primaryClicked: boolean;
  confirmationClicked: boolean;
}

export interface PublishHooks {
  beforeIrreversibleClick?: () => Promise<void>;
  afterIrreversibleClick?: () => Promise<void>;
}

interface PageState { url: string; text: string; pageTitle: string }

interface DraftContentState { title: string; body: string }

const normalizeContent = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const compactContent = (value: string): string => normalizeContent(value).replace(/[\s\u200b-\u200d\ufeff]/g, '');

export function draftContentMatches(expectedTitle: string, expectedBody: string, actual: DraftContentState): boolean {
  const normalizedExpectedBody = compactContent(expectedBody);
  const normalizedActualBody = compactContent(actual.body.replace(/点击输入图片描述[（(]最多30字[）)]/g, ''));
  if (normalizeContent(actual.title) !== normalizeContent(expectedTitle) || normalizedExpectedBody.length === 0) return false;
  // Platforms often append editor placeholders or normalize line boundaries
  // after the adapter writes. Do not reject a complete draft just because the
  // DOM contains harmless trailing/spacing content.
  return normalizedActualBody === normalizedExpectedBody
    || normalizedActualBody.includes(normalizedExpectedBody);
}

export function isNeteasePreflightRunning(text: string): boolean {
  return /正在.{0,12}发文前检测|发文前检测中|正在检测|正在为您进行发文前检测/.test(text);
}

export function isNeteasePreflightComplete(text: string): boolean {
  return /发文前检测(?:已)?完成|检测完成|诊断通过/.test(text);
}

export function shouldContinueNeteaseAfterPreflight(
  state: Pick<PageState, 'text'>,
  preflightObserved: boolean,
  secondPublishClicked: boolean,
  publishButtonAvailable: boolean,
): boolean {
  return preflightObserved
    && !secondPublishClicked
    && publishButtonAvailable
    && !isNeteasePreflightRunning(state.text);
}

export function knownPublishBlocker(text: string): string | null {
  const normalized = normalizeContent(text);
  const quotaBlocker = [
    /今日(?:发文|发布)?额度已用尽/,
    /今日[^。；]{0,24}(?:次数已用完|达到上限|不能再发|剩余\s*0)/,
    /(?:发文|发布)[^。；]{0,24}(?:额度已用尽|次数已用完|达到上限|超过上限)/,
  ].map((pattern) => normalized.match(pattern)?.[0]).find(Boolean);
  if (quotaBlocker) return quotaBlocker;

  const accountBlocker = [
    /您的账号未上线，?暂不支持发布/,
    /(?:您的)?账号(?:信息)?正在审核中，?请耐心等待(?:哦)?/,
    /账号尚未上线[^。；]{0,24}(?:暂不支持|无法|不能)发布/,
    /账号审核未通过[^。；]{0,24}(?:暂不支持|无法|不能)发布/,
  ].map((pattern) => normalized.match(pattern)?.[0]).find(Boolean);
  return accountBlocker || null;
}

const primaryConfig: Record<Platform, { selector?: string; texts: string[]; excludes: string[] }> = {
  baijia: { texts: ['发布'], excludes: ['定时发布'] },
  toutiao: { texts: ['预览并发布'], excludes: ['定时发布'] },
  zhihu: { texts: ['发布'], excludes: [] },
  penguin: { texts: ['发布', '提交审核', '发表'], excludes: ['定时发布'] },
  sohu: { selector: 'li.publish-report-btn', texts: ['发布'], excludes: ['定时发布', '存草稿'] },
  netease: { selector: 'button.primary_button', texts: ['发布', '发布文章', '提交审核'], excludes: ['定时发布', '预览'] },
};

const confirmTexts: Record<Platform, string[]> = {
  baijia: ['确认发布', '确定发布', '确定', '确认'],
  toutiao: ['确认发布'],
  zhihu: ['发布', '确认发布'],
  penguin: ['确认发布', '确定发布', '确定', '确认'],
  sohu: ['确认发布', '确定发布', '确定', '确认'],
  netease: ['继续发布', '确认发布', '确定发布', '确认提交', '确定', '确认'],
};

async function pageState(webContents: WebContents): Promise<PageState> {
  return await webContents.executeJavaScript(`(() => ({
    url: location.href,
    pageTitle: document.title,
    text: String(document.body?.innerText || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 12000),
  }))()`);
}

function isTransientPageReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Render frame was disposed|frame was detached|Object has been destroyed|ERR_ABORTED|navigation|target closed/i.test(message);
}

async function pageStateWithRetry(webContents: WebContents): Promise<PageState> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await pageState(webContents);
    } catch (error) {
      lastError = error;
      if (!isTransientPageReadError(error) || attempt === 3) throw error;
      await delay(500 + attempt * 500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function verifyDraftContent(
  webContents: WebContents,
  platform: Platform,
  title: string,
  html: string,
): Promise<{ matches: boolean; actual: DraftContentState; expectedBodyLength: number }> {
  const content = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const parser = document.createElement('div'); parser.innerHTML = ${JSON.stringify(html)};
    const expectedBody = normalize(parser.innerText || parser.textContent || '');
    const platform = ${JSON.stringify(platform)};
    let title = '';
    let body = '';
    if (platform === 'toutiao') {
      const titleElement = document.querySelector('textarea[placeholder*="标题"],input[placeholder*="标题"]');
      const bodyElement = document.querySelector('.ProseMirror[contenteditable="true"],.ql-editor[contenteditable="true"],[data-editor="content"] [contenteditable="true"]');
      title = titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement ? titleElement.value : '';
      body = bodyElement instanceof HTMLElement ? bodyElement.innerText || bodyElement.textContent || '' : '';
    } else if (platform === 'netease') {
      const titleElement = document.querySelector('textarea.netease-textarea,textarea[placeholder*="标题"]');
      const bodyElement = document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      title = titleElement instanceof HTMLTextAreaElement ? titleElement.value : '';
      body = bodyElement instanceof HTMLElement ? bodyElement.innerText || bodyElement.textContent || '' : '';
    } else if (platform === 'baijia') {
      const visible = (element) => element instanceof HTMLElement && (() => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })();
      const titleElement = [...document.querySelectorAll('[contenteditable="true"],input,textarea')]
        .filter(visible).filter((element) => !String(element.getAttribute('placeholder') || '').includes('关键词'))
        .sort((left, right) => Number(String(right.getAttribute('placeholder') || '').includes('标题')) - Number(String(left.getAttribute('placeholder') || '').includes('标题')))[0];
      title = titleElement instanceof HTMLInputElement || titleElement instanceof HTMLTextAreaElement
        ? titleElement.value : titleElement instanceof HTMLElement ? titleElement.innerText || titleElement.textContent || '' : '';
      const editor = window.UE_V2?.instants?.ueditorInstant0;
      const iframe = [...document.querySelectorAll('iframe')].find((element) => element instanceof HTMLIFrameElement && visible(element) && element.contentDocument?.body);
      body = typeof editor?.getContentTxt === 'function' ? editor.getContentTxt() : iframe instanceof HTMLIFrameElement ? iframe.contentDocument?.body?.innerText || iframe.contentDocument?.body?.textContent || '' : '';
    }
    return { title: normalize(title), body: normalize(body), expectedBody, expectedBodyLength: expectedBody.length };
  })()`);
  return { matches: draftContentMatches(title, content.expectedBody, content), actual: content, expectedBodyLength: content.expectedBodyLength };
}

async function clickVisible(
  webContents: WebContents,
  texts: string[],
  excludes: string[] = [],
  selector = 'button,[role="button"],li',
  dialogOnly = false,
): Promise<boolean> {
  const point = await webContents.executeJavaScript(`(() => {
    const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim();
    const visible=(element)=>element instanceof HTMLElement&&(()=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none';})();
    const texts=${JSON.stringify(texts)};
    const excludes=${JSON.stringify(excludes)};
    const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element)=>{
      if(!visible(element)||element.hasAttribute('disabled')||element.getAttribute('aria-disabled')==='true')return false;
      if(${dialogOnly}&&!element.closest('[role="dialog"],[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"]'))return false;
      const text=normalize(element.textContent);
      return texts.includes(text)&&!excludes.some((value)=>text.includes(value));
    }).sort((left,right)=>{const a=left.getBoundingClientRect();const b=right.getBoundingClientRect();return(a.width*a.height)-(b.width*b.height);});
    const element=candidates[0];
    if(!(element instanceof HTMLElement))return null;
    element.scrollIntoView({block:'center',inline:'nearest'});
    const rect=element.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  if (!point) return false;
  await delay(350);
  await delay(120);
  await cdpClick(webContents, { x: Math.round(point.x), y: Math.round(point.y) });
  return true;
}

async function clickDialogButtonDom(webContents: WebContents, text: string): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim();
    const visible=(element)=>element instanceof HTMLElement&&(()=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';})();
    const button=[...document.querySelectorAll('[role="dialog"] button,[class*="modal"] button,[class*="Modal"] button,[class*="dialog"] button,[class*="Dialog"] button')]
      .filter(visible).find((element)=>normalize(element.textContent)===${JSON.stringify(text)}&&!element.hasAttribute('disabled'));
    if(!(button instanceof HTMLElement))return false;
    button.click();
    return true;
  })()`);
}

async function clickVisibleDom(
  webContents: WebContents,
  texts: string[],
  excludes: string[] = [],
  selector = 'button,[role="button"],li',
): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim();
    const visible=(element)=>element instanceof HTMLElement&&(()=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none';})();
    const texts=${JSON.stringify(texts)}; const excludes=${JSON.stringify(excludes)};
    const element=[...document.querySelectorAll(${JSON.stringify(selector)})].filter((candidate)=>{
      if(!visible(candidate)||candidate.hasAttribute('disabled')||candidate.getAttribute('aria-disabled')==='true')return false;
      const text=normalize(candidate.textContent); return texts.includes(text)&&!excludes.some((value)=>text.includes(value));
    }).sort((left,right)=>{const a=left.getBoundingClientRect();const b=right.getBoundingClientRect();return(a.width*a.height)-(b.width*b.height);})[0];
    if(!(element instanceof HTMLElement))return false;
    element.scrollIntoView({block:'center',inline:'nearest'}); element.click(); return true;
  })()`);
}

async function clickVisibleWithDebugger(
  webContents: WebContents,
  texts: string[],
  excludes: string[] = [],
  selector = 'button,[role="button"],li',
): Promise<boolean> {
  const point = await webContents.executeJavaScript(`(() => {
    const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim();
    const visible=(element)=>element instanceof HTMLElement&&(()=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none';})();
    const texts=${JSON.stringify(texts)}; const excludes=${JSON.stringify(excludes)};
    const element=[...document.querySelectorAll(${JSON.stringify(selector)})].filter((candidate)=>{
      if(!visible(candidate)||candidate.hasAttribute('disabled')||candidate.getAttribute('aria-disabled')==='true')return false;
      const text=normalize(candidate.textContent); return texts.includes(text)&&!excludes.some((value)=>text.includes(value));
    }).sort((left,right)=>{const a=left.getBoundingClientRect();const b=right.getBoundingClientRect();return(a.width*a.height)-(b.width*b.height);})[0];
    if(!(element instanceof HTMLElement))return null;
    element.scrollIntoView({block:'center',inline:'nearest'}); const rect=element.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  if (!point) return false;
  await delay(350);
  const debuggerApi = webContents.debugger;
  const attachedHere = !debuggerApi.isAttached();
  try {
    if (attachedHere) debuggerApi.attach('1.3');
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return true;
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function hasVisibleButton(webContents: WebContents, text: string | string[]): Promise<boolean> {
  const texts = Array.isArray(text) ? text : [text];
  return await webContents.executeJavaScript(`(() => { const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim(); const texts=${JSON.stringify(texts)}; return [...document.querySelectorAll('button,[role="button"]')].some((element)=>{if(!(element instanceof HTMLElement)||!texts.includes(normalize(element.textContent))||element.hasAttribute('disabled')||element.getAttribute('aria-disabled')==='true')return false;const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none';}); })()`);
}

async function hasVisibleDialogText(webContents: WebContents, requiredTexts: string[]): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim();
    const visible=(element)=>element instanceof HTMLElement&&(()=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none';})();
    const required=${JSON.stringify(requiredTexts)};
    const dialogs=[...document.querySelectorAll('[role="dialog"],[class*="modal-wrapper"],[class*="Modal-wrapper"],[class*="dialog-wrapper"],[class*="Dialog-wrapper"]')].filter(visible);
    return dialogs.some((dialog)=>{const text=normalize(dialog.textContent);return required.every((value)=>text.includes(value));});
  })()`);
}

async function hasVisibleDialogButton(webContents: WebContents, text: string): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
    const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim();
    const visible=(element)=>element instanceof HTMLElement&&(()=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none';})();
    return [...document.querySelectorAll('[role="dialog"] button,[class*="modal"] button,[class*="Modal"] button,[class*="dialog"] button,[class*="Dialog"] button')]
      .some((button)=>visible(button)&&!button.hasAttribute('disabled')&&normalize(button.textContent)===${JSON.stringify(text)});
  })()`);
}

async function waitForDialogToClose(
  webContents: WebContents,
  requiredTexts: string[],
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let absentSamples = 0;
  while (Date.now() < deadline) {
    if (await hasVisibleDialogText(webContents, requiredTexts)) {
      absentSamples = 0;
    } else {
      absentSamples += 1;
      if (absentSamples >= 2) return true;
    }
    await delay(250);
  }
  return false;
}

export type ToutiaoPublishAction = 'success' | 'confirm_no_ads' | 'confirm_publish' | 'wait_result' | 'wait_preview';

export type ToutiaoResultCheckAction = 'wait' | 'open_management' | 'refresh_management';
export type PenguinResultCheckAction = 'wait' | 'open_management' | 'refresh_management';

const TOUTIAO_RESULT_TIMEOUT_MS = 120_000;
const TOUTIAO_MANAGEMENT_FALLBACK_DELAY_MS = 10_000;
const TOUTIAO_MANAGEMENT_REFRESH_INTERVAL_MS = 15_000;
const TOUTIAO_MANAGEMENT_URL = 'https://mp.toutiao.com/profile_v4/graphic/articles';
const PENGUIN_RESULT_TIMEOUT_MS = 120_000;
const PENGUIN_MANAGEMENT_FALLBACK_DELAY_MS = 10_000;
const PENGUIN_MANAGEMENT_REFRESH_INTERVAL_MS = 15_000;
const PENGUIN_MANAGEMENT_URL = 'https://om.qq.com/main/management/articleManage';

function isToutiaoManagementPage(url: string): boolean {
  return /\/(?:manage|content|articles)(?:[/?#]|$)/.test(url);
}

function isPenguinManagementPage(url: string): boolean {
  return /\/main\/management\/articleManage(?:[/?#]|$)/.test(url);
}

export function nextToutiaoPublishAction(state: {
  success: boolean;
  noAdsWarningVisible: boolean;
  confirmPublishVisible: boolean;
  confirmationClicked: boolean;
  noAdsConfirmed: boolean;
}): ToutiaoPublishAction {
  if (state.success) return 'success';
  // The ad warning can be rendered after the confirmation dialog. It must win
  // over every other action so a click never lands through an animating modal.
  if (state.noAdsWarningVisible) return 'confirm_no_ads';
  if (state.confirmPublishVisible && !state.confirmationClicked) return 'confirm_publish';
  if (state.confirmationClicked || state.noAdsConfirmed) return 'wait_result';
  return 'wait_preview';
}

export function nextToutiaoResultCheckAction(state: {
  confirmed: boolean;
  managementPage: boolean;
  elapsedMs: number;
  managementFallbackOpened: boolean;
  msSinceLastRefresh: number;
}): ToutiaoResultCheckAction {
  if (!state.confirmed) return 'wait';
  if (!state.managementPage && !state.managementFallbackOpened && state.elapsedMs >= TOUTIAO_MANAGEMENT_FALLBACK_DELAY_MS) {
    return 'open_management';
  }
  if (state.managementPage && state.msSinceLastRefresh >= TOUTIAO_MANAGEMENT_REFRESH_INTERVAL_MS) {
    return 'refresh_management';
  }
  return 'wait';
}

export function nextPenguinResultCheckAction(state: {
  managementPage: boolean;
  elapsedMs: number;
  managementFallbackOpened: boolean;
  msSinceLastRefresh: number;
}): PenguinResultCheckAction {
  if (!state.managementPage && !state.managementFallbackOpened && state.elapsedMs >= PENGUIN_MANAGEMENT_FALLBACK_DELAY_MS) {
    return 'open_management';
  }
  if (state.managementPage && state.msSinceLastRefresh >= PENGUIN_MANAGEMENT_REFRESH_INTERVAL_MS) {
    return 'refresh_management';
  }
  return 'wait';
}

async function publishToutiaoAfterPrimary(webContents: WebContents, title: string): Promise<PublishResult> {
  const noAdsTexts = ['选择了“不投放广告”', '不会产生广告收益'];
  const deadline = Date.now() + TOUTIAO_RESULT_TIMEOUT_MS;
  let state = await pageStateWithRetry(webContents);
  let confirmationClicked = false;
  let noAdsConfirmed = false;
  let noAdsAttempts = 0;
  let resultCheckStartedAt = 0;
  let managementFallbackOpened = false;
  let lastManagementRefreshAt = Date.now();

  while (Date.now() < deadline) {
    state = await pageStateWithRetry(webContents);
    const noAdsWarningVisible = await hasVisibleDialogText(webContents, noAdsTexts);
    // Headline's preview UI has two variants: some accounts render the final
    // confirmation inside a dialog, while others render it directly in the
    // preview pane. The no-ads dialog still takes precedence over both.
    const confirmPublishVisible = !noAdsWarningVisible && (
      await hasVisibleDialogButton(webContents, '确认发布')
      || await hasVisibleButton(webContents, '确认发布')
    );
    const action = nextToutiaoPublishAction({
      success: isPublishSuccess('toutiao', state, title),
      noAdsWarningVisible,
      confirmPublishVisible,
      confirmationClicked,
      noAdsConfirmed,
    });

    const blocked = await blocker(webContents, state);
    if (blocked) {
      return { status: 'action_required', platform: 'toutiao', title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
    }
    if (action === 'success') {
      return { status: 'success', platform: 'toutiao', title, stage: 'success', message: '文章已提交并在作品管理页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
    }
    if (action === 'confirm_no_ads') {
      if (noAdsAttempts >= 3) {
        return { status: 'action_required', platform: 'toutiao', title, stage: 'toutiao_ad_confirm', message: 'TOUTIAO_AD_CONFIRM_FAILED: “不投放广告”确认弹窗未能关闭', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
      }
      noAdsAttempts += 1;
      const clicked = await clickVisible(webContents, ['确定'], ['取消'], 'button,[role="button"]', true);
      if (!clicked || !(await waitForDialogToClose(webContents, noAdsTexts))) continue;
      noAdsConfirmed = true;
      resultCheckStartedAt = Date.now();
      continue;
    }
    if (action === 'confirm_publish') {
      // Toutiao's primary action is React-driven and already uses DOM click.
      // Use the same path for its final confirmation, then never click that
      // irreversible control twice merely because its exit animation lingers.
      const clicked = await clickDialogButtonDom(webContents, '确认发布')
        || await clickVisibleDom(webContents, ['确认发布'], ['取消'], 'button,[role="button"]');
      if (clicked) {
        confirmationClicked = true;
        resultCheckStartedAt = Date.now();
      }
      await delay(500);
      continue;
    }
    const resultCheckAction = nextToutiaoResultCheckAction({
      confirmed: confirmationClicked || noAdsConfirmed,
      managementPage: isToutiaoManagementPage(state.url),
      elapsedMs: resultCheckStartedAt === 0 ? 0 : Date.now() - resultCheckStartedAt,
      managementFallbackOpened,
      msSinceLastRefresh: Date.now() - lastManagementRefreshAt,
    });
    if (resultCheckAction === 'open_management') {
      managementFallbackOpened = true;
      await webContents.loadURL(TOUTIAO_MANAGEMENT_URL);
      lastManagementRefreshAt = Date.now();
      continue;
    }
    if (resultCheckAction === 'refresh_management') {
      webContents.reload();
      lastManagementRefreshAt = Date.now();
      await delay(1_000);
      continue;
    }
    await delay(250);
  }

  state = await pageStateWithRetry(webContents);
  if (confirmationClicked || noAdsConfirmed) {
    return { status: 'result_uncertain', platform: 'toutiao', title, stage: 'result_check', message: '头条号发布流程已确认，但在 120 秒内未能在作品管理页确认文章状态，已停止操作', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
  }
  return { status: 'action_required', platform: 'toutiao', title, stage: 'toutiao_preview', message: 'TOUTIAO_PREVIEW_TIMEOUT: 点击预览并发布后未出现可确认状态', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: false };
}

async function publishPenguinAfterPrimary(webContents: WebContents, title: string): Promise<PublishResult> {
  const startedAt = Date.now();
  const deadline = startedAt + PENGUIN_RESULT_TIMEOUT_MS;
  let state = await pageStateWithRetry(webContents);
  let confirmationClicked = false;
  let managementFallbackOpened = false;
  let lastManagementRefreshAt = Date.now();

  while (Date.now() < deadline) {
    state = await pageStateWithRetry(webContents);
    const blocked = await blocker(webContents, state);
    if (blocked) {
      return { status: 'action_required', platform: 'penguin', title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
    }
    if (isPublishSuccess('penguin', state, title)) {
      return { status: 'success', platform: 'penguin', title, stage: 'success', message: '文章已提交并在内容管理页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
    }
    if (!confirmationClicked) {
      for (const text of confirmTexts.penguin) {
        confirmationClicked = await clickDialogButtonDom(webContents, text);
        if (confirmationClicked) break;
      }
      if (confirmationClicked) {
        await delay(500);
        continue;
      }
    }
    const action = nextPenguinResultCheckAction({
      managementPage: isPenguinManagementPage(state.url),
      elapsedMs: Date.now() - startedAt,
      managementFallbackOpened,
      msSinceLastRefresh: Date.now() - lastManagementRefreshAt,
    });
    if (action === 'open_management') {
      managementFallbackOpened = true;
      await webContents.loadURL(PENGUIN_MANAGEMENT_URL);
      lastManagementRefreshAt = Date.now();
      continue;
    }
    if (action === 'refresh_management') {
      webContents.reload();
      lastManagementRefreshAt = Date.now();
      await delay(1_000);
      continue;
    }
    await delay(250);
  }

  state = await pageStateWithRetry(webContents);
  return {
    status: 'result_uncertain', platform: 'penguin', title, stage: 'result_check',
    message: '企鹅号发布操作已执行，但在 120 秒内未能在内容管理页找到目标标题，已停止操作；再次发布前请先人工核对',
    url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked,
  };
}

export function isPublishSuccess(platform: Platform, state: PageState, title: string): boolean {
  const hasTitle = state.text.includes(title);
  const positive = /发布成功|提交成功|审核中|待审核|已发布|发布中/.test(state.text);
  const explicitSuccess = /文章发布成功|发布成功|提交成功|已成功提交/.test(state.text);
  if (platform === 'zhihu') return !/\/edit(?:\?|$)/.test(state.url) && /zhuanlan\.zhihu\.com\/p\//.test(state.url);
  if (platform === 'toutiao') {
    return !state.url.includes('/graphic/publish') && isToutiaoManagementPage(state.url) && hasTitle && positive;
  }
  if (platform === 'baijia') return (!/publish|editor|\/edit(?:\?|$)/.test(state.url) && hasTitle && positive) || explicitSuccess;
  if (platform === 'penguin') return explicitSuccess || (!state.url.includes('/creation/article') && hasTitle && positive);
  if (platform === 'sohu') return !state.url.includes('addarticle') && hasTitle && positive;
  return !state.url.includes('article-publish') && hasTitle && positive;
}

async function blocker(webContents: WebContents, state: PageState): Promise<string | null> {
  if (/(?:login|passport|signin)/i.test(state.url)) return '登录失效';

  const known = knownPublishBlocker(state.text);
  if (known) return known;

  const quota = [
    /今日[^。]{0,24}(?:次数已用完|达到上限|不能再发|剩余\s*0)/,
    /发布[^。]{0,24}(?:次数已用完|达到上限|超过上限)/,
  ].map((pattern) => state.text.match(pattern)?.[0]).find(Boolean);
  if (quota) return quota;

  return await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const pattern = /验证码|安全验证|滑块验证|扫码验证|账号异常|登录失效|请重新登录|账号未上线|账号尚未上线|账号审核未通过|标题不能为空|正文不能为空|请选择封面|请上传封面|内容不符合规范|发布失败|提交失败/;
    const selectors = [
      '[role="dialog"]', '[role="alert"]', '[role="status"]',
      '[class*="toast"]', '[class*="Toast"]', '[class*="message"]', '[class*="Message"]',
      '[class*="notice"]', '[class*="Notice"]', '[class*="error"]', '[class*="Error"]'
    ].join(',');
    const candidate = [...document.querySelectorAll(selectors)].filter(visible).find((element) => {
      if (element.closest('[contenteditable="true"],.ProseMirror,.ql-editor,.public-DraftEditor-content')) return false;
      const text = normalize(element.textContent);
      return text.length > 0 && text.length <= 300 && pattern.test(text);
    });
    return candidate ? normalize(candidate.textContent).slice(0, 160) : null;
  })()`);
}

export async function publishFilledDraft(
  webContents: WebContents,
  platform: Platform,
  title: string,
  html = '',
  hooks: PublishHooks = {},
): Promise<PublishResult> {
  if (html && ['baijia', 'toutiao', 'netease'].includes(platform)) {
    const verification = await verifyDraftContent(webContents, platform, title, html);
    if (!verification.matches) {
      const state = await pageStateWithRetry(webContents);
      return {
        status: 'action_required', platform, title, stage: 'draft_verify',
        message: `DRAFT_CONTENT_NOT_STABLE: 发布前页面内容校验失败（标题=${normalizeContent(verification.actual.title) === normalizeContent(title)}，正文长度=${verification.actual.body.length}/${verification.expectedBodyLength}），已停止发布`,
        url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: false, confirmationClicked: false,
      };
    }
  }
  const preflightState = await pageStateWithRetry(webContents);
  const preflightBlocker = await blocker(webContents, preflightState);
  if (preflightBlocker) {
    return {
      status: 'action_required', platform, title, stage: 'publish_blocked',
      message: `平台阻止发布：${preflightBlocker}`,
      url: preflightState.url, pageText: preflightState.text.slice(0, 1000), primaryClicked: false, confirmationClicked: false,
    };
  }
  const config = primaryConfig[platform];
  await hooks.beforeIrreversibleClick?.();
  const primaryClicked = platform === 'penguin'
    ? await clickVisibleWithDebugger(webContents, config.texts, config.excludes, config.selector || 'button,[role="button"],li')
    : platform === 'baijia' || platform === 'toutiao'
      ? await clickVisibleDom(webContents, config.texts, config.excludes, config.selector || 'button,[role="button"],li')
      : await clickVisible(webContents, config.texts, config.excludes, config.selector || 'button,[role="button"],li');
  if (primaryClicked) await hooks.afterIrreversibleClick?.();
  if (!primaryClicked) {
    const state = await pageStateWithRetry(webContents);
    return { status: 'action_required', platform, title, stage: 'publish_click', message: '未能定位或点击主发布按钮', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: false, confirmationClicked: false };
  }

  if (platform === 'toutiao') return await publishToutiaoAfterPrimary(webContents, title);
  if (platform === 'penguin') return await publishPenguinAfterPrimary(webContents, title);

  let confirmationClicked = false;
  let neteasePreflightObserved = false;
  let neteaseSecondPublishClicked = false;
  let state = await pageStateWithRetry(webContents);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(attempt === 0 ? 1500 : 1000);
    state = await pageStateWithRetry(webContents);
    const blocked = await blocker(webContents, state);
    if (blocked) {
      return { status: 'action_required', platform, title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
    }
    if (isPublishSuccess(platform, state, title)) {
      return { status: 'success', platform, title, stage: 'success', message: '文章已提交并在发布结果页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
    }
    if (platform === 'netease') {
      if (isNeteasePreflightRunning(state.text)) {
        neteasePreflightObserved = true;
        continue;
      }
      if (isNeteasePreflightComplete(state.text)) neteasePreflightObserved = true;
      const publishButtonAvailable = await hasVisibleButton(webContents, ['发布', '发布文章', '提交审核']);
      if (shouldContinueNeteaseAfterPreflight(
        state,
        neteasePreflightObserved,
        neteaseSecondPublishClicked,
        publishButtonAvailable,
      )) {
        neteaseSecondPublishClicked = await clickVisible(
          webContents,
          ['发布', '发布文章', '提交审核'],
          ['取消', '定时发布', '预览'],
          'button.primary_button,button,[role="button"]',
        );
        if (neteaseSecondPublishClicked) continue;
      }
      if (!confirmationClicked && /确认发布|确定发布|确认提交/.test(state.text)) {
        confirmationClicked = await clickVisible(
          webContents,
          ['确认发布', '确定发布', '确认提交'],
          ['取消'],
          'button,[role="button"]',
          true,
        );
      }
      continue;
    }
    if (!confirmationClicked) {
      if (platform === 'baijia') {
        for (const text of confirmTexts[platform]) {
          confirmationClicked = await clickDialogButtonDom(webContents, text);
          if (confirmationClicked) break;
        }
      } else {
        confirmationClicked = await clickVisible(webContents, confirmTexts[platform], ['取消'], 'button,[role="button"],div,span', true);
      }
      if (confirmationClicked) continue;
    }
  }
  const message = platform === 'netease'
    ? `网易号发布结果未确认（检测已观察=${neteasePreflightObserved}，第二阶段点击=${neteaseSecondPublishClicked}），已停止本次操作；再次发布可能产生重复内容`
    : '点击发布后未检测到明确成功结果，已停止本次操作；再次发布可能产生重复内容';
  return { status: 'result_uncertain', platform, title, stage: 'result_check', message, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
}
