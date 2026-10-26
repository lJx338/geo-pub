import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishFilledDraft,
  draftContentMatches,
  withPublishEvidence,
  isNeteasePreflightRunning,
  isNeteasePreflightComplete,
  isPublishSuccess,
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

  it('recognizes a Toutiao article when the management list inserts whitespace', () => {
    expect(isPublishSuccess('toutiao', {
      url: 'https://mp.toutiao.com/profile_v4/graphic/articles',
      pageTitle: '作品管理',
      text: '食品级硅胶密封圈为什么要做二次硫化 去掉发物？ 审核中',
    }, '食品级硅胶密封圈为什么要做二次硫化去掉发物？')).toBe(true);
  });

  it('does not accept a management page without the matching title and status', () => {
    expect(isPublishSuccess('toutiao', {
      url: 'https://mp.toutiao.com/profile_v4/graphic/articles',
      pageTitle: '作品管理',
      text: '其他文章 审核中',
    }, '内容发布前如何减少重复修改')).toBe(false);
  });

  it('recognizes a Penguin article on the article management page', () => {
    expect(isPublishSuccess('penguin', {
      url: 'https://om.qq.com/article/articleManage',
      pageTitle: '作品管理',
      text: '食品级硅胶密封圈为什么要做二次硫化，去掉发物？ 审核中',
    }, '食品级硅胶密封圈为什么要做二次硫化，去掉发物？')).toBe(true);
  });

  it('recognizes a newly accepted Penguin article while it is processing', () => {
    expect(isPublishSuccess('penguin', {
      url: 'https://om.qq.com/main/contentManage',
      pageTitle: '内容管理',
      text: '内容管理 测试连接发布流程 加工中',
    }, '测试连接发布流程')).toBe(true);
  });

  it('does not treat the Penguin editor as a confirmed publish result', () => {
    expect(isPublishSuccess('penguin', {
      url: 'https://om.qq.com/main/creation/article',
      pageTitle: '发布文章',
      text: '食品级硅胶密封圈为什么要做二次硫化，去掉发物？ 发布成功',
    }, '食品级硅胶密封圈为什么要做二次硫化，去掉发物？')).toBe(false);
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


describe('publish screenshot evidence', () => {
  it.each(['success', 'result_uncertain', 'action_required'] as const)('preserves %s when screenshot capture fails', (status) => {
    const result = withPublishEvidence({
      status, platform: 'sohu', title: '测试文章', stage: 'result_check',
      message: '平台返回结果', url: 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page',
      pageText: '测试文章 已发布', primaryClicked: true, confirmationClicked: false,
    }, null);
    expect(result.status).toBe(status);
    expect(result.screenshotStatus).toBe('unavailable');
    expect(result.screenshotPath).toBeNull();
    if (status === 'success') expect(result.message).toContain('请勿重复发布');
    else expect(result.message).toBe('平台返回结果');
  });
});


describe('Zhihu publish orchestration', () => {
  afterEach(() => vi.useRealTimers());
  const draft = { url: 'https://zhuanlan.zhihu.com/p/42/edit', pageTitle: '写文章', text: '标题 正文 草稿 发布' };

  function fixture(options: { confirmation?: boolean; covered?: boolean; lostAcknowledgement?: boolean; success?: boolean; blocked?: boolean } = {}) {
    let primaryCount = 0;
    let confirmationCount = 0;
    const webContents = {
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes('clickZhihuPublishControl')) {
          if (script.endsWith(', "primary")')) {
            if (options.covered) return { clicked: false, reason: 'covered' };
            primaryCount++;
            if (options.lostAcknowledgement) throw new Error('Execution context was destroyed');
            return { clicked: true, reason: 'clicked' };
          }
          if (options.confirmation && !confirmationCount) {
            confirmationCount++;
            return { clicked: true, reason: 'clicked' };
          }
          return { clicked: false, reason: 'missing' };
        }
        if (script.includes('pageTitle: document.title')) {
          return options.success && (options.confirmation ? confirmationCount : primaryCount)
            ? { ...draft, url: 'https://zhuanlan.zhihu.com/p/42' } : draft;
        }
        return options.blocked ? '安全验证' : null;
      }),
      sendInputEvent: vi.fn(),
    };
    return { webContents, counts: () => [primaryCount, confirmationCount] };
  }

  it('does not resend the primary click when the page stays a draft', async () => {
    vi.useFakeTimers();
    const { webContents, counts } = fixture();
    const completion = publishFilledDraft(webContents as never, 'zhihu', '标题');
    await vi.runAllTimersAsync();
    expect(await completion).toMatchObject({ status: 'result_uncertain', primaryClicked: true, confirmationClicked: false });
    expect(counts()).toEqual([1, 0]);
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each([false, true])('recognizes success with confirmation=%s and activates each step once', async confirmation => {
    vi.useFakeTimers();
    const { webContents, counts } = fixture({ confirmation, success: true });
    const completion = publishFilledDraft(webContents as never, 'zhihu', '标题');
    await vi.runAllTimersAsync();
    expect(await completion).toMatchObject({ status: 'success', primaryClicked: true, confirmationClicked: confirmation });
    expect(counts()).toEqual([1, Number(confirmation)]);
  });

  it('reports an obstructed primary button without claiming a click', async () => {
    const { webContents, counts } = fixture({ covered: true });
    expect(await publishFilledDraft(webContents as never, 'zhihu', '标题')).toMatchObject({
      status: 'action_required', stage: 'publish_click', primaryClicked: false,
    });
    expect(counts()).toEqual([0, 0]);
  });

  it('preserves uncertainty after a lost click acknowledgement without retrying', async () => {
    vi.useFakeTimers();
    const { webContents, counts } = fixture({ lostAcknowledgement: true });
    const completion = publishFilledDraft(webContents as never, 'zhihu', '标题');
    await vi.runAllTimersAsync();
    expect(await completion).toMatchObject({ status: 'result_uncertain' });
    expect(counts()).toEqual([1, 0]);
  });

  it('can confirm a navigation even when the click acknowledgement was lost', async () => {
    vi.useFakeTimers();
    const { webContents, counts } = fixture({ lostAcknowledgement: true, success: true });
    const completion = publishFilledDraft(webContents as never, 'zhihu', '标题');
    await vi.runAllTimersAsync();
    expect(await completion).toMatchObject({ status: 'success' });
    expect(counts()).toEqual([1, 0]);
  });

  it('verifies Zhihu content again before dispatching any publish click', async () => {
    const webContents = { executeJavaScript: vi.fn()
      .mockResolvedValueOnce({ title: '标题', body: '', expectedBody: '完整正文', expectedBodyLength: 4 })
      .mockResolvedValue(draft) };
    expect(await publishFilledDraft(webContents as never, 'zhihu', '标题', '<p>完整正文</p>')).toMatchObject({
      status: 'action_required', stage: 'draft_verify', primaryClicked: false,
    });
    expect(webContents.executeJavaScript.mock.calls.some(([script]) => String(script).includes('clickZhihuPublishControl'))).toBe(false);
  });

  it('stops before clicking when a platform verification prompt is present', async () => {
    const { webContents, counts } = fixture({ blocked: true });
    expect(await publishFilledDraft(webContents as never, 'zhihu', '标题')).toMatchObject({ status: 'action_required', stage: 'publish_blocked' });
    expect(counts()).toEqual([0, 0]);
  });

  it.each(['https://zhuanlan.zhihu.com/p/42/edit#settings', 'https://zhuanlan.zhihu.com/p/42/edit/', 'https://example.com/zhuanlan.zhihu.com/p/42'])('does not misreport an editor or unrelated URL as success: %s', url => {
    expect(isPublishSuccess('zhihu', { ...draft, url }, '标题')).toBe(false);
  });
});
