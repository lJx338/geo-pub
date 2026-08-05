import { describe, expect, it } from 'vitest';
import {
  isNeteasePreflightRunning,
  isNeteasePreflightComplete,
  isPublishSuccess,
  shouldContinueNeteaseAfterPreflight,
} from './publish-adapter.js';

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
});

describe('NetEase pre-publish check', () => {
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
