import { describe, expect, it } from 'vitest';
import {
  draftContentMatches,
  isNeteasePreflightRunning,
  isNeteasePreflightComplete,
  isPublishSuccess,
  knownPublishBlocker,
  nextToutiaoPublishAction,
  nextToutiaoResultCheckAction,
  nextPenguinResultCheckAction,
  shouldContinueNeteaseAfterPreflight,
} from './publish-adapter.js';

describe('pre-publish content verification', () => {
  it('rejects a draft whose editor body was cleared after fill', () => {
    expect(draftContentMatches('标题', '应当保留的正文', { title: '标题', body: '' })).toBe(false);
  });

  it('accepts matching content after whitespace normalization', () => {
    expect(draftContentMatches('标题', '第一段\n第二段', { title: '标题', body: '第一段  第二段' })).toBe(true);
  });

  it('accepts harmless editor text appended after the complete body', () => {
    expect(draftContentMatches('标题', '第一段第二段', { title: '标题', body: '第一段第二段保存中' })).toBe(true);
  });

  it('ignores the NetEase image description placeholder added by the editor', () => {
    expect(draftContentMatches('标题', '第一段第二段', {
      title: '标题',
      body: '第一段点击输入图片描述（最多30字）第二段',
    })).toBe(true);
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

  it('waits for the no-ads warning before clicking any visible publish confirmation', () => {
    expect(nextToutiaoPublishAction({
      success: false,
      noAdsWarningVisible: true,
      confirmPublishVisible: true,
      confirmationClicked: false,
      noAdsConfirmed: false,
    })).toBe('confirm_no_ads');
  });

  it('keeps waiting for delayed dialogs after the publish confirmation was clicked', () => {
    expect(nextToutiaoPublishAction({
      success: false,
      noAdsWarningVisible: false,
      confirmPublishVisible: false,
      confirmationClicked: true,
      noAdsConfirmed: false,
    })).toBe('wait_result');
  });

  it('does not click the same Toutiao confirmation twice while it is disappearing', () => {
    expect(nextToutiaoPublishAction({
      success: false,
      noAdsWarningVisible: false,
      confirmPublishVisible: true,
      confirmationClicked: true,
      noAdsConfirmed: false,
    })).toBe('wait_result');
  });

  it('opens the management page once when the result page does not appear after confirmation', () => {
    expect(nextToutiaoResultCheckAction({
      confirmed: true,
      managementPage: false,
      elapsedMs: 10_000,
      managementFallbackOpened: false,
      msSinceLastRefresh: 0,
    })).toBe('open_management');
    expect(nextToutiaoResultCheckAction({
      confirmed: true,
      managementPage: false,
      elapsedMs: 30_000,
      managementFallbackOpened: true,
      msSinceLastRefresh: 0,
    })).toBe('wait');
  });

  it('refreshes the management list while waiting for an asynchronously created article', () => {
    expect(nextToutiaoResultCheckAction({
      confirmed: true,
      managementPage: true,
      elapsedMs: 20_000,
      managementFallbackOpened: false,
      msSinceLastRefresh: 15_000,
    })).toBe('refresh_management');
  });

  it('accepts an explicit Penguin success message on the editor route', () => {
    expect(isPublishSuccess('penguin', {
      url: 'https://om.qq.com/main/creation/article',
      pageTitle: '腾讯内容开放平台',
      text: '文章发布成功，请等待审核',
    }, '测试文章')).toBe(true);
  });

  it('opens and refreshes Penguin management while reconciling the result', () => {
    expect(nextPenguinResultCheckAction({
      managementPage: false,
      elapsedMs: 10_000,
      managementFallbackOpened: false,
      msSinceLastRefresh: 0,
    })).toBe('open_management');
    expect(nextPenguinResultCheckAction({
      managementPage: true,
      elapsedMs: 30_000,
      managementFallbackOpened: true,
      msSinceLastRefresh: 15_000,
    })).toBe('refresh_management');
  });
});

describe('NetEase pre-publish check', () => {
  it('blocks Penguin when the daily publishing quota is exhausted', () => {
    expect(knownPublishBlocker('已保存 正文字数：2594 今日发文额度已用尽 发布 定时发布')).toBe('今日发文额度已用尽');
  });

  it('blocks an account that is still being reviewed before clicking publish', () => {
    expect(knownPublishBlocker('您的账号信息正在审核中，请耐心等待哦')).toBe('您的账号信息正在审核中，请耐心等待哦');
    expect(knownPublishBlocker('您的账号未上线，暂不支持发布')).toBe('您的账号未上线，暂不支持发布');
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
