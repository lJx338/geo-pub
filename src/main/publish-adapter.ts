import type { WebContents } from 'electron';
import type { Platform } from '../shared/protocol.js';

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

interface PageState { url: string; text: string; pageTitle: string }

interface DraftContentState { title: string; body: string }

const normalizeContent = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const compactContent = (value: string): string => normalizeContent(value).replace(/[\s\u200b-\u200d\ufeff]/g, '');
const compactTitle = (value: string): string => compactContent(value).toLocaleLowerCase();
const TOUTIAO_ARTICLES_URL = 'https://mp.toutiao.com/profile_v4/graphic/articles';
const PENGUIN_ARTICLES_URL = 'https://om.qq.com/article/articleManage';

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
  webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
  await delay(120);
  webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
  return true;
}

async function clickVisibleDom(
  webContents: WebContents,
  texts: string[],
  excludes: string[] = [],
  selector = 'button,[role="button"],li',
  dialogOnly = false,
): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => {
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
    if(!(element instanceof HTMLElement))return false;
    element.scrollIntoView({block:'center',inline:'nearest'});
    element.click();
    return true;
  })()`);
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

async function hasVisibleButton(webContents: WebContents, text: string | string[]): Promise<boolean> {
  const texts = Array.isArray(text) ? text : [text];
  return await webContents.executeJavaScript(`(() => { const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim(); const texts=${JSON.stringify(texts)}; return [...document.querySelectorAll('button,[role="button"]')].some((element)=>{if(!(element instanceof HTMLElement)||!texts.includes(normalize(element.textContent))||element.hasAttribute('disabled')||element.getAttribute('aria-disabled')==='true')return false;const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none';}); })()`);
}

async function publishToutiaoAfterPrimary(webContents: WebContents, title: string): Promise<PublishResult> {
  let state = await pageState(webContents);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await delay(attempt === 0 ? 1200 : 800);
    state = await pageState(webContents);
    if (isPublishSuccess('toutiao', state, title)) {
      return { status: 'success', platform: 'toutiao', title, stage: 'success', message: '文章已提交并在作品管理页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: false };
    }
    if (state.text.includes('选择了“不投放广告”') && state.text.includes('不会产生广告收益')) {
      let closed = false;
      for (let retry = 0; retry < 3; retry += 1) {
        await clickDialogButtonDom(webContents, '确定');
        await delay(900 + retry * 400);
        state = await pageState(webContents);
        if (!state.text.includes('选择了“不投放广告”') || !state.text.includes('不会产生广告收益')) { closed = true; break; }
      }
      if (!closed) return { status: 'action_required', platform: 'toutiao', title, stage: 'toutiao_ad_confirm', message: 'TOUTIAO_AD_CONFIRM_FAILED: 未能关闭“不投放广告”确认弹窗', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: false };
    }
    if (await hasVisibleButton(webContents, '确认发布')) {
      let clicked = false;
      for (let retry = 0; retry < 3; retry += 1) {
        clicked = await clickVisibleDom(webContents, ['确认发布'], [], 'button,[role="button"]')
          || await clickVisible(webContents, ['确认发布'], [], 'button,[role="button"]');
        await delay(1000 + retry * 500);
        if (!(await hasVisibleButton(webContents, '确认发布'))) break;
      }
      if (!clicked || await hasVisibleButton(webContents, '确认发布')) {
        state = await pageState(webContents);
        return { status: 'action_required', platform: 'toutiao', title, stage: 'toutiao_confirm_publish', message: 'TOUTIAO_CONFIRM_PUBLISH_FAILED: 自动点击后确认发布按钮仍然存在', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: clicked };
      }
      for (let resultAttempt = 0; resultAttempt < 30; resultAttempt += 1) {
        await delay(1000);
        state = await pageState(webContents);
        if (isPublishSuccess('toutiao', state, title)) return { status: 'success', platform: 'toutiao', title, stage: 'success', message: '文章已提交并在作品管理页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: true };
        const blocked = await blocker(webContents, state);
        if (blocked) return { status: 'action_required', platform: 'toutiao', title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: true };
      }
      // Toutiao may finish publishing successfully while the publish editor
      // remains open or while its SPA route has not updated yet. Re-open the
      // article management list and reconcile by the exact title before
      // reporting an uncertain result. This keeps the audit record aligned
      // with the platform's authoritative published list.
      const reconciliation = await reconcileToutiaoPublishedArticle(webContents, title);
      if (reconciliation.match) return { status: 'success', platform: 'toutiao', title, stage: 'management_reconcile', message: '已在头条作品管理页核验发布结果', url: reconciliation.match.url, pageText: reconciliation.match.text.slice(0, 1000), primaryClicked: true, confirmationClicked: true };
      const evidenceState = reconciliation.last ?? state;
      return { status: 'result_uncertain', platform: 'toutiao', title, stage: 'result_check', message: '已复核头条作品管理页，但暂未找到匹配文章，停止自动重试', url: evidenceState.url, pageText: evidenceState.text.slice(0, 1000), primaryClicked: true, confirmationClicked: true };
    }
  }
  // Even when the confirmation dialog never becomes visible, the platform
  // may have accepted the request asynchronously. Always consult the
  // authoritative works-management list before reporting an uncertain result.
  const reconciliation = await reconcileToutiaoPublishedArticle(webContents, title);
  if (reconciliation.match) return { status: 'success', platform: 'toutiao', title, stage: 'management_reconcile', message: '已在头条作品管理页核验发布结果', url: reconciliation.match.url, pageText: reconciliation.match.text.slice(0, 1000), primaryClicked: true, confirmationClicked: false };
  const evidenceState = reconciliation.last ?? state;
  return { status: 'result_uncertain', platform: 'toutiao', title, stage: 'result_check', message: '发布后未检测到明确成功状态，已复核头条作品管理页但暂未找到匹配文章，停止自动重试', url: evidenceState.url, pageText: evidenceState.text.slice(0, 1000), primaryClicked: true, confirmationClicked: false };
}

interface ReconciliationResult {
  match: PageState | null;
  last: PageState | null;
}

async function reconcileToutiaoPublishedArticle(webContents: WebContents, title: string): Promise<ReconciliationResult> {
  let last: PageState | null = null;
  try {
    const current = await pageStateWithRetry(webContents);
    last = current;
    if (isPublishSuccess('toutiao', current, title)) return { match: current, last };

    if (!isToutiaoManagementPage(current)) {
      await webContents.loadURL(TOUTIAO_ARTICLES_URL);
    } else {
      webContents.reload();
    }
  } catch (error) {
    if (!isTransientPageReadError(error)) return { match: null, last };
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(attempt === 0 ? 1500 : 1000);
    try {
      const state = await pageStateWithRetry(webContents);
      last = state;
      if (isPublishSuccess('toutiao', state, title)) return { match: state, last };
    } catch (error) {
      if (!isTransientPageReadError(error)) return { match: null, last };
    }
  }
  return { match: null, last };
}

function isPenguinManagementPage(state: PageState): boolean {
  const url = state.url.toLocaleLowerCase();
  return /\/(?:article\/articlemanage|management\/articlemanage|articlemanage)(?:[/?#]|$)/.test(url)
    || (!url.includes('/creation/article') && /作品管理|内容管理/.test(`${state.pageTitle} ${state.text}`));
}

async function reconcilePenguinPublishedArticle(webContents: WebContents, title: string): Promise<ReconciliationResult> {
  let last: PageState | null = null;
  try {
    const current = await pageStateWithRetry(webContents);
    last = current;
    if (isPublishSuccess('penguin', current, title)) return { match: current, last };

    if (!isPenguinManagementPage(current)) {
      await webContents.loadURL(PENGUIN_ARTICLES_URL);
    } else {
      webContents.reload();
    }
  } catch (error) {
    if (!isTransientPageReadError(error)) return { match: null, last };
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(attempt === 0 ? 1500 : 1000);
    try {
      const state = await pageStateWithRetry(webContents);
      last = state;
      if (isPublishSuccess('penguin', state, title)) return { match: state, last };
    } catch (error) {
      if (!isTransientPageReadError(error)) return { match: null, last };
    }
  }
  return { match: null, last };
}

export function isPublishSuccess(platform: Platform, state: PageState, title: string): boolean {
  const hasTitle = compactTitle(state.text).includes(compactTitle(title));
  // Penguin's content-management list briefly labels a newly accepted article
  // “加工中” before it becomes “审核中” or “已发布”. It is an authoritative
  // post-submit state when the exact title is present on that management page.
  const positive = /发布成功|提交成功|审核中|待审核|已发布|发布中|加工中|处理中/.test(state.text);
  if (platform === 'zhihu') return !/\/edit(?:\?|$)/.test(state.url) && /zhuanlan\.zhihu\.com\/p\//.test(state.url);
  if (platform === 'toutiao') {
    return isToutiaoManagementPage(state) && hasTitle && positive;
  }
  if (platform === 'baijia') return (!/publish|editor/.test(state.url) && hasTitle && positive) || /文章发布成功|发布成功|提交成功/.test(state.text);
  if (platform === 'penguin') return isPenguinManagementPage(state) && hasTitle && positive;
  if (platform === 'sohu') return !state.url.includes('addarticle') && hasTitle && positive;
  return !state.url.includes('article-publish') && hasTitle && positive;
}

export function isToutiaoManagementPage(state: Pick<PageState, 'url'>): boolean {
  return !state.url.includes('/graphic/publish')
    && /\/profile_v4\/(?:manage|content|graphic\/articles|articles)(?:[/?#]|$)/.test(state.url);
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
    const candidate = [...document.querySelectorAll(selectors)].filter(visible).find((element) => {
      if (element.closest('[contenteditable="true"],.ProseMirror,.ql-editor,.public-DraftEditor-content')) return false;
      const text = normalize(element.textContent);
      return text.length > 0 && text.length <= 300 && pattern.test(text);
    });
    return candidate ? normalize(candidate.textContent).slice(0, 160) : null;
  })()`);
}

export async function publishFilledDraft(webContents: WebContents, platform: Platform, title: string, html = ''): Promise<PublishResult> {
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
  const config = primaryConfig[platform];
  const primaryClicked = platform === 'toutiao'
    ? await clickVisibleDom(webContents, config.texts, config.excludes, config.selector || 'button,[role="button"],li')
      || await clickVisible(webContents, config.texts, config.excludes, config.selector || 'button,[role="button"],li')
    : await clickVisible(webContents, config.texts, config.excludes, config.selector || 'button,[role="button"],li');
  if (!primaryClicked) {
    const state = await pageStateWithRetry(webContents);
    return { status: 'action_required', platform, title, stage: 'publish_click', message: '未能定位或点击主发布按钮', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: false, confirmationClicked: false };
  }

  if (platform === 'toutiao') return await publishToutiaoAfterPrimary(webContents, title);

  let confirmationClicked = false;
  let neteasePreflightObserved = false;
  let neteaseSecondPublishClicked = false;
  let state = await pageStateWithRetry(webContents);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(attempt === 0 ? 1500 : 1000);
    state = await pageStateWithRetry(webContents);
    if (isPublishSuccess(platform, state, title)) {
      return { status: 'success', platform, title, stage: 'success', message: '文章已提交并在发布结果页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
    }
    const blocked = await blocker(webContents, state);
    if (blocked) {
      return { status: 'action_required', platform, title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
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
      confirmationClicked = await clickVisible(webContents, confirmTexts[platform], ['取消'], 'button,[role="button"],div,span', true);
      if (confirmationClicked) continue;
    }
  }
  const message = platform === 'netease'
    ? `网易号发布结果未确认（检测已观察=${neteasePreflightObserved}，第二阶段点击=${neteaseSecondPublishClicked}），已停止操作，禁止自动重发`
    : '点击发布后未检测到明确成功结果，已停止操作，禁止自动重发';
  if (platform === 'penguin') {
    const reconciliation = await reconcilePenguinPublishedArticle(webContents, title);
    if (reconciliation.match) {
      return { status: 'success', platform, title, stage: 'management_reconcile', message: '已在企鹅号作品管理页核验发布结果', url: reconciliation.match.url, pageText: reconciliation.match.text.slice(0, 1000), primaryClicked, confirmationClicked };
    }
    const evidenceState = reconciliation.last ?? state;
    return { status: 'result_uncertain', platform, title, stage: 'result_check', message: '已复核企鹅号作品管理页，但暂未找到匹配文章，停止自动重试', url: evidenceState.url, pageText: evidenceState.text.slice(0, 1000), primaryClicked, confirmationClicked };
  }
  return { status: 'result_uncertain', platform, title, stage: 'result_check', message, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
}
