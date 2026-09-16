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
  /** Internal-only stable classification for task history and diagnostics. */
  errorCode?: string;
  /** A successful submission can still be awaiting platform moderation. */
  outcome?: 'submitted' | 'published';
  receipt?: { url: string; titleMatched: boolean; state: 'submitted' | 'published' };
}

export interface PublishHooks {
  beforeIrreversibleClick?: () => Promise<void>;
  afterIrreversibleClick?: () => Promise<void>;
}

interface PageState { url: string; text: string; pageTitle: string }

interface DraftContentState { title: string; body: string }

export interface PlatformPublishTitle {
  requestedTitle: string;
  effectiveTitle: string;
  adjusted: boolean;
  minimumLength: number;
}

const normalizeContent = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const compactContent = (value: string): string => normalizeContent(value).replace(/[\s\u200b-\u200d\ufeff]/g, '');

export function platformPublishTitle(platform: Platform, title: string): PlatformPublishTitle {
  const requestedTitle = normalizeContent(title);
  const minimumLength = platform === 'penguin' || platform === 'netease' ? 5 : 2;
  const missing = Math.max(0, minimumLength - Array.from(requestedTitle).length);
  return {
    requestedTitle,
    effectiveTitle: `${requestedTitle}${'。'.repeat(missing)}`,
    adjusted: missing > 0,
    minimumLength,
  };
}

export function draftContentMatches(expectedTitle: string, expectedBody: string, actual: DraftContentState): boolean {
  const normalizedExpectedBody = compactContent(expectedBody);
  const normalizedActualBody = compactContent(actual.body.replace(/点击输入图片描述[（(]最多30字[）)]/g, ''));
  if (normalizeContent(actual.title) !== normalizeContent(expectedTitle) || normalizedExpectedBody.length === 0) return false;
  return normalizedActualBody === normalizedExpectedBody;
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

const primaryConfig: Record<Platform, { selector?: string; texts: string[]; excludes: string[] }> = {
  baijia: { texts: ['发布'], excludes: ['定时发布'] },
  toutiao: { texts: ['预览并发布'], excludes: ['定时发布'] },
  zhihu: { texts: ['发布'], excludes: [] },
  penguin: { texts: ['发布', '提交审核', '发表'], excludes: ['定时发布'] },
  sohu: { selector: 'li.publish-report-btn', texts: ['发布'], excludes: ['定时发布', '存草稿'] },
  netease: { selector: 'button.primary_button', texts: ['发布', '发布文章', '提交审核'], excludes: ['定时发布', '预览'] },
};

const SOHU_MANAGEMENT_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page';
const TOUTIAO_MANAGEMENT_URL = 'https://mp.toutiao.com/profile_v4/graphic/articles';

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

export type ToutiaoPublishAction = 'success' | 'confirm_no_ads' | 'dismiss_sync_authorization' | 'confirm_publish' | 'wait_result' | 'wait_preview';

export function nextToutiaoPublishAction(state: {
  success: boolean;
  noAdsWarningVisible: boolean;
  syncAuthorizationVisible: boolean;
  confirmPublishVisible: boolean;
  confirmationClicked: boolean;
  noAdsConfirmed: boolean;
}): ToutiaoPublishAction {
  // This consent dialog appears on the management page after submission. Never
  // leave it open and never opt the account into cross-product sync implicitly.
  if (state.syncAuthorizationVisible) return 'dismiss_sync_authorization';
  if (state.success) return 'success';
  // The ad warning can be rendered after the confirmation dialog. It must win
  // over publish-button handling so a click never lands through an animating modal.
  if (state.noAdsWarningVisible) return 'confirm_no_ads';
  if (state.confirmPublishVisible) return 'confirm_publish';
  if (state.confirmationClicked || state.noAdsConfirmed) return 'wait_result';
  return 'wait_preview';
}

async function publishToutiaoAfterPrimary(webContents: WebContents, title: string): Promise<PublishResult> {
  const noAdsTexts = ['选择了“不投放广告”', '不会产生广告收益'];
  const syncAuthorizationTexts = ['作品同步授权', '开启作品同步后'];
  const deadline = Date.now() + 55_000;
  let state = await pageState(webContents);
  let confirmationClicked = false;
  let noAdsConfirmed = false;
  let noAdsAttempts = 0;
  let syncAuthorizationAttempts = 0;
  let confirmationAttempts = 0;
  let lastConfirmationClickAt = 0;
  let managementRefreshes = 0;
  let managementObservedAt = 0;
  let lastManagementRefreshAt = 0;

  while (Date.now() < deadline) {
    state = await pageState(webContents);
    const noAdsWarningVisible = await hasVisibleDialogText(webContents, noAdsTexts);
    const syncAuthorizationVisible = await hasVisibleDialogText(webContents, syncAuthorizationTexts);
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
      syncAuthorizationVisible,
      confirmPublishVisible,
      confirmationClicked,
      noAdsConfirmed,
    });

    if (action === 'success') {
      const receipt = publishReceipt(state, title);
      return { status: 'success', platform: 'toutiao', title, stage: 'success', message: '文章已提交并在作品管理页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked, outcome: receipt.state, receipt };
    }
    const blocked = await blocker(webContents, state);
    if (blocked) {
      return { status: 'action_required', platform: 'toutiao', title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
    }
    if (action === 'confirm_no_ads') {
      if (noAdsAttempts >= 3) {
        return { status: 'action_required', platform: 'toutiao', title, stage: 'toutiao_ad_confirm', message: 'TOUTIAO_AD_CONFIRM_FAILED: “不投放广告”确认弹窗未能关闭', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
      }
      noAdsAttempts += 1;
      const clicked = await clickVisible(webContents, ['确定'], ['取消'], 'button,[role="button"]', true);
      if (!clicked || !(await waitForDialogToClose(webContents, noAdsTexts))) continue;
      noAdsConfirmed = true;
      continue;
    }
    if (action === 'dismiss_sync_authorization') {
      if (syncAuthorizationAttempts >= 3) {
        return {
          status: 'result_uncertain', platform: 'toutiao', title, stage: 'toutiao_sync_authorization',
          errorCode: 'TOUTIAO_SYNC_AUTHORIZATION_DISMISS_FAILED',
          message: '头条号文章可能已提交，但作品同步授权弹窗未能关闭；为避免重复发布，已停止本次操作',
          url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked,
        };
      }
      syncAuthorizationAttempts += 1;
      const clicked = await clickVisible(webContents, ['取消'], [], 'button,[role="button"]', true);
      if (!clicked || !(await waitForDialogToClose(webContents, syncAuthorizationTexts))) continue;
      // The list is commonly rendered before this one-time consent dialog is
      // answered. Force the first reconciliation refresh immediately afterward.
      managementObservedAt = Date.now() - 1_000;
      lastManagementRefreshAt = 0;
      continue;
    }
    if (action === 'confirm_publish') {
      // A confirmed click may trigger a second modal asynchronously. Give the
      // page time to render that state before considering another click.
      if (confirmationClicked && Date.now() - lastConfirmationClickAt < 2_500) {
        await delay(250);
        continue;
      }
      if (confirmationAttempts >= 3) {
        return { status: 'action_required', platform: 'toutiao', title, stage: 'toutiao_confirm_publish', message: 'TOUTIAO_CONFIRM_PUBLISH_FAILED: 自动点击后确认发布按钮仍然存在', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
      }
      confirmationAttempts += 1;
      const clicked = await clickVisible(webContents, ['确认发布'], ['取消'], 'button,[role="button"]');
      if (clicked) {
        confirmationClicked = true;
        lastConfirmationClickAt = Date.now();
      }
      // Do not assume the page is ready immediately after the click. A late
      // “不投放广告” warning is handled by the next condition-driven pass.
      await delay(250);
      continue;
    }
    if (action === 'wait_result' && isToutiaoManagementPage(state)) {
      const now = Date.now();
      if (managementObservedAt === 0) managementObservedAt = now;
      const refreshDelays = [1_000, 5_000, 10_000, 15_000];
      const delayBeforeRefresh = refreshDelays[managementRefreshes];
      const referenceTime = lastManagementRefreshAt || managementObservedAt;
      if (delayBeforeRefresh !== undefined && now - referenceTime >= delayBeforeRefresh) {
        managementRefreshes += 1;
        lastManagementRefreshAt = now;
        if (state.url !== TOUTIAO_MANAGEMENT_URL) await webContents.loadURL(TOUTIAO_MANAGEMENT_URL);
        else webContents.reload();
        await delay(1_500);
        continue;
      }
    }
    await delay(250);
  }

  state = await pageState(webContents);
  if (confirmationClicked || noAdsConfirmed) {
    const message = isToutiaoManagementPage(state)
      ? '头条号已进入作品管理页，但限定时间内未看到本次标题；文章可能已提交，请勿直接重复发布'
      : '头条号发布确认已执行，但限定时间内未进入作品管理页；文章可能已提交，请勿直接重复发布';
    return { status: 'result_uncertain', platform: 'toutiao', title, stage: 'result_check', message, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked };
  }
  return { status: 'action_required', platform: 'toutiao', title, stage: 'toutiao_preview', message: 'TOUTIAO_PREVIEW_TIMEOUT: 点击预览并发布后未出现可确认状态', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: false };
}

export function isToutiaoManagementPage(state: Pick<PageState, 'url'>): boolean {
  return !state.url.includes('/graphic/publish')
    && /\/profile_v4\/(?:manage|content|graphic\/articles)(?:[/?#]|$)/.test(state.url);
}

export function isPublishSuccess(platform: Platform, state: PageState, title: string): boolean {
  const hasTitle = state.text.includes(title);
  const positive = /发布成功|提交成功|审核中|待审核|已发布|发布中/.test(state.text);
  if (platform === 'zhihu') return !/\/edit(?:\?|$)/.test(state.url) && /zhuanlan\.zhihu\.com\/p\//.test(state.url) && hasTitle;
  if (platform === 'toutiao') {
    return isToutiaoManagementPage(state) && hasTitle && positive;
  }
  if (platform === 'baijia') {
    const dedicatedReceipt = /\/builder\/rc\/clue(?:[?#]|$)/.test(state.url)
      && /提交成功/.test(state.text)
      && /正在审核中|审核中/.test(state.text);
    return dedicatedReceipt || (!/publish|editor/.test(state.url) && hasTitle && positive);
  }
  if (platform === 'penguin') return !state.url.includes('/creation/article') && hasTitle && positive;
  if (platform === 'sohu') return !state.url.includes('addarticle') && hasTitle && positive;
  return !state.url.includes('article-publish') && hasTitle && positive;
}

export function canAcceptCapturedPublishSuccess(
  platform: Platform,
  stateText: string,
  neteaseSecondPublishClicked: boolean,
): boolean {
  return platform !== 'netease'
    || (neteaseSecondPublishClicked && !isNeteasePreflightRunning(stateText));
}

interface CapturedPublishSignal {
  success: boolean;
  failure: string | null;
  matchedText: string | null;
}

async function armPublishSignalCapture(webContents: WebContents): Promise<void> {
  await webContents.executeJavaScript(`(() => {
    try { window.__geoPublisherPublishSignalObserver?.disconnect?.(); } catch {}
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const successPattern = /发布成功|提交成功|发布完成|提交审核成功/;
    const failurePattern = /验证码|安全验证|滑块验证|扫码验证|标题.{0,12}(?:至少|最少|不少于|不能少于).{0,8}5|标题长度.{0,8}(?:不足|不符合)|发布失败|提交失败|内容不符合规范/;
    const signalSelector = '[role="alert"],[role="status"],[role="dialog"],[class*="toast" i],[class*="message" i],[class*="notice" i],[class*="modal" i],[class*="dialog" i]';
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
      for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0.01) return false;
      }
      return true;
    })();
    window.__geoPublisherPublishSignals = [];
    const record = (node) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const candidate = element?.matches?.(signalSelector) ? element : element?.closest?.(signalSelector);
      if (!(candidate instanceof HTMLElement) || !visible(candidate)) return;
      const text = normalize(candidate.textContent);
      if (!text || text.length > 300) return;
      const success = text.match(successPattern)?.[0] || null;
      const failure = text.match(failurePattern)?.[0] || null;
      if (!success && !failure) return;
      const entry = { at: Date.now(), success, failure, text: text.slice(0, 160) };
      const last = window.__geoPublisherPublishSignals.at(-1);
      if (!last || last.success !== entry.success || last.failure !== entry.failure || last.text !== entry.text) {
        window.__geoPublisherPublishSignals.push(entry);
        if (window.__geoPublisherPublishSignals.length > 30) window.__geoPublisherPublishSignals.shift();
      }
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        record(mutation.target);
        for (const node of mutation.addedNodes) record(node);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.__geoPublisherPublishSignalObserver = observer;
    return true;
  })()`);
}

async function capturedPublishSignal(webContents: WebContents): Promise<CapturedPublishSignal> {
  return await webContents.executeJavaScript(`(() => {
    const entries = Array.isArray(window.__geoPublisherPublishSignals) ? window.__geoPublisherPublishSignals : [];
    const failure = [...entries].reverse().find((entry) => entry?.failure);
    const success = [...entries].reverse().find((entry) => entry?.success);
    return {
      success: Boolean(success),
      failure: failure ? String(failure.failure || failure.text || '').slice(0, 160) : null,
      matchedText: success ? String(success.success || success.text || '').slice(0, 160) : null,
    };
  })()`);
}

export function penguinQuotaExhaustedReason(value: unknown): string | null {
  const text = normalizeContent(String(value || ''));
  const match = [
    /(?:今日|今天|当日|每日).{0,20}(?:发布|发文).{0,24}(?:额度.{0,8}(?:已用完|不足)|次数.{0,8}(?:已用完|达到上限)|(?:剩余|可用).{0,6}0\s*(?:次|篇)?)/,
    /(?:发布|发文).{0,16}(?:额度.{0,8}(?:已用完|不足)|次数.{0,8}(?:已用完|达到上限)|(?:剩余|可用).{0,6}0\s*(?:次|篇)?)/,
    /(?:今日|今天|当日|每日).{0,16}(?:还可发布|可发布|可发).{0,6}0\s*(?:次|篇)?/,
  ].map((pattern) => text.match(pattern)?.[0]).find(Boolean);
  return match || null;
}

export function isBaijiaManagementPage(state: Pick<PageState, 'url' | 'pageTitle'>): boolean {
  if (/\/(?:edit|publish)(?:[/?#]|$)/i.test(state.url)) return false;
  return /\/(?:content|manage|article|list)(?:[/?#]|$)/i.test(state.url)
    || /(?:内容|作品|文章)管理/.test(state.pageTitle);
}

export function baijiaReconciliationAction(
  attempt: number,
  state: Pick<PageState, 'url' | 'pageTitle'>,
): 'open_management' | 'refresh_management' | 'wait' {
  if (isBaijiaManagementPage(state)) {
    return [10, 20, 35, 50].includes(attempt) ? 'refresh_management' : 'wait';
  }
  const leftEditor = !/\/(?:edit|publish)(?:[/?#]|$)/i.test(state.url);
  return leftEditor && attempt >= 2 && (attempt - 2) % 6 === 0 ? 'open_management' : 'wait';
}

async function openBaijiaManagementPage(webContents: WebContents): Promise<boolean> {
  return await clickVisible(
    webContents,
    ['查看发布状态', '内容管理', '作品管理', '文章管理', '图文管理'],
    [],
    'a,button,[role="button"],li,span',
  );
}

async function penguinQuotaPreflight(webContents: WebContents): Promise<string | null> {
  const signals = await webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
      for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0.01) return false;
      }
      return true;
    })();
    const quotaNodes = [...document.querySelectorAll('[class*="quota" i],[class*="limit" i],[class*="count" i],[class*="publish" i],[id*="quota" i],[id*="limit" i],[title],[aria-label]')]
      .filter(visible)
      .map((element) => [element.getAttribute('title') || '', element.getAttribute('aria-label') || '', element.textContent || ''].join(' '))
      .filter((text) => /额度|次数|剩余|可发布|可发|上限/.test(text));
    return [...quotaNodes, String(document.body?.innerText || '')].map(normalize).filter(Boolean).join('\\n');
  })()`);
  return penguinQuotaExhaustedReason(signals);
}

function publishReceipt(state: PageState, title: string): NonNullable<PublishResult['receipt']> {
  return {
    url: state.url,
    titleMatched: state.text.includes(title),
    state: /审核中|待审核|发布中|提交成功/.test(state.text)
      ? 'submitted'
      : /发布成功|已发布/.test(state.text) ? 'published' : 'submitted',
  };
}

async function blocker(webContents: WebContents, state: PageState): Promise<string | null> {
  if (/(?:login|passport|signin)/i.test(state.url)) return '登录失效';

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
    const pattern = /验证码|安全验证|滑块验证|扫码验证|账号异常|登录失效|请重新登录|标题不能为空|正文不能为空|请选择封面|请上传封面|内容不符合规范|发布失败|提交失败/;
    const selectors = [
      '[role="dialog"]', '[role="alert"]', '[role="status"]',
      '[class*="toast"]', '[class*="Toast"]', '[class*="message"]', '[class*="Message"]',
      '[class*="notice"]', '[class*="Notice"]', '[class*="error"]', '[class*="Error"]'
    ].join(',');
    const captchaFrame = [...document.querySelectorAll('iframe')].filter(visible).find((element) => {
      if (!/captcha|tcaptcha|turing/i.test([element.id, element.getAttribute('name'), element.getAttribute('src')].join(' '))) return false;
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || element.contains(hit);
    });
    if (captchaFrame) return '检测到安全验证/滑块验证，请在平台页面完成验证后重试';
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
  if (platform === 'penguin') {
    const quota = await penguinQuotaPreflight(webContents);
    if (quota) {
      const state = await pageStateWithRetry(webContents);
      return {
        status: 'action_required', platform, title, stage: 'quota_preflight',
        errorCode: 'PENGUIN_QUOTA_EXHAUSTED',
        message: '企鹅号今日发布额度已用完，文章已保留在草稿中，请明天再发布或切换有额度的账号。',
        url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: false, confirmationClicked: false,
      };
    }
  }
  const config = primaryConfig[platform];
  await armPublishSignalCapture(webContents);
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

  let confirmationClicked = false;
  let neteasePreflightObserved = false;
  let neteaseSecondPublishClicked = false;
  let state = await pageStateWithRetry(webContents);
  const maxAttempts = platform === 'baijia' ? 60 : 120;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(attempt === 0 ? 1500 : 1000);
    state = await pageStateWithRetry(webContents);
    if (isPublishSuccess(platform, state, title)) {
      const receipt = publishReceipt(state, title);
      return { status: 'success', platform, title, stage: 'success', message: '文章已提交并在发布结果页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked, outcome: receipt.state, receipt };
    }
    const blocked = await blocker(webContents, state);
    if (blocked) {
      const quota = platform === 'penguin' ? penguinQuotaExhaustedReason(blocked) : null;
      return quota
        ? {
            status: 'action_required', platform, title, stage: 'publish_blocked', errorCode: 'PENGUIN_QUOTA_EXHAUSTED',
            message: '企鹅号今日发布额度已用完，文章已保留在草稿中，请明天再发布或切换有额度的账号。',
            url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked,
          }
        : { status: 'action_required', platform, title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
    }
    const capturedSignal = await capturedPublishSignal(webContents);
    if (capturedSignal.success && canAcceptCapturedPublishSuccess(platform, state.text, neteaseSecondPublishClicked)) {
      const receipt = publishReceipt({ ...state, text: `${state.text} ${capturedSignal.matchedText || ''}` }, title);
      return { status: 'success', platform, title, stage: 'success_signal', message: '文章已提交并捕获到平台成功提示', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked, outcome: receipt.state, receipt };
    }
    if (capturedSignal.failure) {
      return { status: 'action_required', platform, title, stage: 'publish_blocked', message: `平台阻止发布：${capturedSignal.failure}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
    }
    if (platform === 'baijia') {
      const action = baijiaReconciliationAction(attempt, state);
      if (action === 'open_management') {
        if (await openBaijiaManagementPage(webContents)) {
          await delay(1_000);
          continue;
        }
      } else if (action === 'refresh_management') {
        webContents.reload();
        await delay(1_500);
        continue;
      }
    }
    if (platform === 'sohu' && state.url.includes('/contentManagement/news/addarticle') && attempt === 8) {
      await webContents.loadURL(SOHU_MANAGEMENT_URL);
      await delay(1_500);
      continue;
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
        neteaseSecondPublishClicked = await clickVisibleDom(
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
      if (platform === 'baijia' || platform === 'penguin') {
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
    : platform === 'baijia'
      ? '百家号已执行发布，但作品列表在一分钟内尚未同步。请先到内容管理中确认，避免重复发布。'
      : '点击发布后未检测到明确成功结果，已停止本次操作；再次发布可能产生重复内容';
  return {
    status: 'result_uncertain', platform, title, stage: 'result_check',
    ...(platform === 'baijia' ? { errorCode: 'BAIJIA_RECONCILIATION_TIMEOUT' } : {}),
    message, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked,
  };
}
