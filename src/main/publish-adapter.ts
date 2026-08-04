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

async function hasVisibleButton(webContents: WebContents, text: string): Promise<boolean> {
  return await webContents.executeJavaScript(`(() => { const normalize=(value)=>String(value||'').replace(/\\s+/g,' ').trim(); return [...document.querySelectorAll('button,[role="button"]')].some((element)=>{if(!(element instanceof HTMLElement)||normalize(element.textContent)!==${JSON.stringify(text)})return false;const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';}); })()`);
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
        clicked = await clickVisible(webContents, ['确认发布'], [], 'button,[role="button"]');
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
        const blocked = blocker(state);
        if (blocked) return { status: 'action_required', platform: 'toutiao', title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: true };
      }
      return { status: 'result_uncertain', platform: 'toutiao', title, stage: 'result_check', message: '确认发布后 30 秒内未进入作品管理页，已停止操作', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: true };
    }
  }
  return { status: 'action_required', platform: 'toutiao', title, stage: 'toutiao_preview', message: 'TOUTIAO_PREVIEW_TIMEOUT: 点击预览并发布后未进入可确认状态', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: true, confirmationClicked: false };
}

export function isPublishSuccess(platform: Platform, state: PageState, title: string): boolean {
  const hasTitle = state.text.includes(title);
  const positive = /发布成功|提交成功|审核中|待审核|已发布|发布中/.test(state.text);
  if (platform === 'zhihu') return !/\/edit(?:\?|$)/.test(state.url) && /zhuanlan\.zhihu\.com\/p\//.test(state.url);
  if (platform === 'toutiao') {
    const isManagementPage = /\/(?:manage|content|articles)(?:[/?#]|$)/.test(state.url);
    return !state.url.includes('/graphic/publish') && isManagementPage && hasTitle && positive;
  }
  if (platform === 'baijia') return (!/publish|editor/.test(state.url) && hasTitle && positive) || /文章发布成功|发布成功|提交成功/.test(state.text);
  if (platform === 'penguin') return !state.url.includes('/creation/article') && hasTitle && positive;
  if (platform === 'sohu') return !state.url.includes('addarticle') && hasTitle && positive;
  return !state.url.includes('article-publish') && hasTitle && positive;
}

function blocker(state: PageState): string | null {
  const patterns = [
    /今日[^。]{0,24}(?:次数已用完|达到上限|不能再发|剩余\s*0)/,
    /发布[^。]{0,24}(?:次数已用完|达到上限|超过上限)/,
    /(?:验证码|安全验证|滑块验证|扫码验证|账号异常|登录失效|请重新登录)/,
    /(?:标题不能为空|正文不能为空|请选择封面|请上传封面|内容不符合规范|审核未通过|发布失败|提交失败)/,
  ];
  return patterns.map((pattern) => state.text.match(pattern)?.[0]).find(Boolean) || null;
}

export async function publishFilledDraft(webContents: WebContents, platform: Platform, title: string): Promise<PublishResult> {
  const config = primaryConfig[platform];
  const primaryClicked = await clickVisible(webContents, config.texts, config.excludes, config.selector || 'button,[role="button"],li');
  if (!primaryClicked) {
    const state = await pageState(webContents);
    return { status: 'action_required', platform, title, stage: 'publish_click', message: '未能定位或点击主发布按钮', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked: false, confirmationClicked: false };
  }

  if (platform === 'toutiao') return await publishToutiaoAfterPrimary(webContents, title);

  let confirmationClicked = false;
  let neteasePreflightAdvanced = false;
  let state = await pageState(webContents);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(attempt === 0 ? 1500 : 1000);
    state = await pageState(webContents);
    if (isPublishSuccess(platform, state, title)) {
      return { status: 'success', platform, title, stage: 'success', message: '文章已提交并在发布结果页确认', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
    }
    const blocked = blocker(state);
    if (blocked) {
      return { status: 'action_required', platform, title, stage: 'publish_blocked', message: `平台阻止发布：${blocked}`, url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
    }
    if (!confirmationClicked) {
      confirmationClicked = await clickVisible(webContents, confirmTexts[platform], ['取消'], 'button,[role="button"],div,span', true);
      if (confirmationClicked) continue;
    }
    if (platform === 'netease' && !neteasePreflightAdvanced && /发文前检测|发布前检测|检测完成/.test(state.text)) {
      neteasePreflightAdvanced = await clickVisible(webContents, ['继续发布', '发布'], ['取消', '定时发布'], 'button,[role="button"]');
    }
  }
  return { status: 'result_uncertain', platform, title, stage: 'result_check', message: '点击发布后未检测到明确成功结果，已停止操作，禁止自动重发', url: state.url, pageText: state.text.slice(0, 1000), primaryClicked, confirmationClicked };
}
