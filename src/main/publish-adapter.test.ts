import { describe, expect, it } from 'vitest';
import { isPublishSuccess } from './publish-adapter.js';

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
