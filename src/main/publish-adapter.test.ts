import { describe, expect, it } from 'vitest';
import {
  draftContentMatches,
  isNeteasePreflightRunning,
  isNeteasePreflightComplete,
  isPublishSuccess,
  isToutiaoManagementPage,
  nextToutiaoPublishAction,
  shouldContinueNeteaseAfterPreflight,
  penguinQuotaExhaustedReason,
  baijiaReconciliationAction,
  isBaijiaManagementPage,
  platformPublishTitle,
  canAcceptCapturedPublishSuccess,
} from './publish-adapter.js';

describe('platform publish title constraints', () => {
  it('minimally extends four-character titles for Penguin and NetEase', () => {
    expect(platformPublishTitle('penguin', '安全测试')).toEqual({
      requestedTitle: '安全测试', effectiveTitle: '安全测试。', adjusted: true, minimumLength: 5,
    });
    expect(platformPublishTitle('netease', '安全测试').effectiveTitle).toBe('安全测试。');
  });

  it('does not alter valid titles or platforms without the five-character minimum', () => {
    expect(platformPublishTitle('penguin', '安全测试用').adjusted).toBe(false);
    expect(platformPublishTitle('sohu', '安全测试').effectiveTitle).toBe('安全测试');
  });
});

describe('pre-publish content verification', () => {
  it('rejects a draft whose editor body was cleared after fill', () => {
    expect(draftContentMatches('标题', '应当保留的正文', { title: '标题', body: '' })).toBe(false);
  });

  it('accepts matching content after whitespace normalization', () => {
    expect(draftContentMatches('标题', '第一段\n第二段', { title: '标题', body: '第一段  第二段' })).toBe(true);
  });

  it('rejects appended or duplicated editor text', () => {
    expect(draftContentMatches('标题', '第一段第二段', { title: '标题', body: '第一段第二段保存中' })).toBe(false);
    expect(draftContentMatches('标题', '第一段第二段', { title: '标题', body: '第一段第二段第一段第二段' })).toBe(false);
  });

  it('ignores the NetEase image description placeholder added by the editor', () => {
    expect(draftContentMatches('标题', '第一段第二段', {
      title: '标题',
      body: '第一段点击输入图片描述（最多30字）第二段',
    })).toBe(true);
  });
});

describe('企鹅号发布额度预检', () => {
  it('recognizes exhausted publish quota language before a publish click', () => {
    expect(penguinQuotaExhaustedReason('今日发布额度已用完，请明日再试')).toContain('今日发布额度已用完');
    expect(penguinQuotaExhaustedReason('今日还可发布 0 篇')).toContain('今日还可发布 0 篇');
    expect(penguinQuotaExhaustedReason('今日可发布 5 篇，已发布 1 篇')).toBeNull();
  });
});

describe('publish result reconciliation', () => {
  it('recognizes Toutiao graphic articles page with matching audited article', () => {
    expect(isPublishSuccess('toutiao', {
      url: 'https://mp.toutiao.com/profile_v4/graphic/articles',
      pageTitle: '作品管理',
      text: '内容发布前如何减少重复修改 08-05 00:56 审核中',
    }, '内容发布前如何减少重复修改')).toBe(true);
  });

  it('does not accept a management page without the matching title and status', () => {
    expect(isPublishSuccess('toutiao', {
      url: 'https://mp.toutiao.com/profile_v4/graphic/articles',
      pageTitle: '作品管理',
      text: '其他文章 审核中',
    }, '内容发布前如何减少重复修改')).toBe(false);
  });

  it('requires the published Zhihu page to contain this task title', () => {
    expect(isPublishSuccess('zhihu', {
      url: 'https://zhuanlan.zhihu.com/p/123456', pageTitle: '别的文章', text: '别的文章 正文',
    }, '本次测试文章')).toBe(false);
  });

  it('does not treat a generic Baijia toast as a receipt', () => {
    expect(isPublishSuccess('baijia', {
      url: 'https://baijiahao.baidu.com/builder/rc/edit', pageTitle: '编辑器', text: '文章发布成功',
    }, '本次测试文章')).toBe(false);
  });

  it('accepts the dedicated Baijia submission page without waiting for list synchronization', () => {
    expect(isPublishSuccess('baijia', {
      url: 'https://baijiahao.baidu.com/builder/rc/clue?from=news',
      pageTitle: '百家号',
      text: '提交成功，正在审核中... 查看发布状态再写一篇 文章发布成功',
    }, '海边黄昏最值得记录的三种变化')).toBe(true);
  });

  it('rejects a Baijia clue page that only contains a generic success toast', () => {
    expect(isPublishSuccess('baijia', {
      url: 'https://baijiahao.baidu.com/builder/rc/clue?from=news',
      pageTitle: '百家号',
      text: '文章发布成功',
    }, '海边黄昏最值得记录的三种变化')).toBe(false);
  });

  it('actively enters and refreshes Baijia content management while waiting for list sync', () => {
    const intermediate = { url: 'https://baijiahao.baidu.com/builder/rc/clue?from=news', pageTitle: '百家号' };
    const management = { url: 'https://baijiahao.baidu.com/builder/rc/content', pageTitle: '内容管理' };
    expect(isBaijiaManagementPage(intermediate)).toBe(false);
    expect(baijiaReconciliationAction(2, intermediate)).toBe('open_management');
    expect(baijiaReconciliationAction(3, intermediate)).toBe('wait');
    expect(isBaijiaManagementPage(management)).toBe(true);
    expect(baijiaReconciliationAction(10, management)).toBe('refresh_management');
    expect(baijiaReconciliationAction(11, management)).toBe('wait');
    expect(baijiaReconciliationAction(50, management)).toBe('refresh_management');
  });

  it('waits for the no-ads warning before clicking any visible publish confirmation', () => {
    expect(nextToutiaoPublishAction({
      success: false,
      noAdsWarningVisible: true,
      syncAuthorizationVisible: false,
      confirmPublishVisible: true,
      confirmationClicked: false,
      noAdsConfirmed: false,
    })).toBe('confirm_no_ads');
  });

  it('keeps waiting for delayed dialogs after the publish confirmation was clicked', () => {
    expect(nextToutiaoPublishAction({
      success: false,
      noAdsWarningVisible: false,
      syncAuthorizationVisible: false,
      confirmPublishVisible: false,
      confirmationClicked: true,
      noAdsConfirmed: false,
    })).toBe('wait_result');
  });

  it('dismisses the post-publish sync authorization before accepting success', () => {
    expect(nextToutiaoPublishAction({
      success: true,
      noAdsWarningVisible: false,
      syncAuthorizationVisible: true,
      confirmPublishVisible: false,
      confirmationClicked: true,
      noAdsConfirmed: false,
    })).toBe('dismiss_sync_authorization');
  });

  it('distinguishes the Toutiao management page from the article editor', () => {
    expect(isToutiaoManagementPage({ url: 'https://mp.toutiao.com/profile_v4/graphic/articles' })).toBe(true);
    expect(isToutiaoManagementPage({ url: 'https://mp.toutiao.com/profile_v4/graphic/publish' })).toBe(false);
  });
});

describe('NetEase pre-publish check', () => {
  it('does not accept a captured success signal before the second publish click', () => {
    expect(canAcceptCapturedPublishSuccess('netease', '正在为您进行发文前检测...', false)).toBe(false);
    expect(canAcceptCapturedPublishSuccess('netease', '标题 诊断通过', false)).toBe(false);
  });

  it('accepts a captured success signal only after the second click and completed preflight', () => {
    expect(canAcceptCapturedPublishSuccess('netease', '正在为您进行发文前检测...', true)).toBe(false);
    expect(canAcceptCapturedPublishSuccess('netease', '标题 诊断通过', true)).toBe(true);
    expect(canAcceptCapturedPublishSuccess('sohu', '发布成功', false)).toBe(true);
  });

  it('waits while the pre-publish check is still running', () => {
    const state = { text: '为保证展现效果，正在为您进行发文前检测…' };
    expect(isNeteasePreflightRunning(state.text)).toBe(true);
    expect(shouldContinueNeteaseAfterPreflight(state, true, false, true)).toBe(false);
  });

  it('allows one second publish click after the observed check has finished', () => {
    const state = { text: '标题 诊断通过 正文 诊断通过' };
    expect(isNeteasePreflightComplete(state.text)).toBe(true);
    expect(shouldContinueNeteaseAfterPreflight(state, true, false, true)).toBe(true);
    expect(shouldContinueNeteaseAfterPreflight(state, true, true, true)).toBe(false);
  });

  it('does not invent a second publish click when no check was observed', () => {
    expect(shouldContinueNeteaseAfterPreflight({ text: '发布设置' }, false, false, true)).toBe(false);
  });
});
