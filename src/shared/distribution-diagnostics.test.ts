import { describe, expect, it } from 'vitest';
import { buildDistributionDiagnosis, distributionDiagnosisText } from './distribution-diagnostics.js';

describe('distribution diagnostics', () => {
  it('explains a Baijia cover failure and allows a safe pre-publish retry', () => {
    const diagnosis = buildDistributionDiagnosis({
      platform: 'baijia',
      title: '测试文章',
      status: 'failed',
      payload: { mode: 'publish', error: { code: 'BAIJIA_COVER_NOT_APPLIED', message: '封面上传后未确认应用状态' } },
    });
    expect(diagnosis.title).toContain('封面');
    expect(diagnosis.retry).toContain('可以重试');
    expect(diagnosis.evidence).toContain('代码：BAIJIA_COVER_NOT_APPLIED');
  });

  it('explains a Toutiao cover failure before publishing is attempted', () => {
    const diagnosis = buildDistributionDiagnosis({
      platform: 'toutiao', title: '测试文章', status: 'failed',
      payload: { mode: 'publish', error: { code: 'TOUTIAO_COVER_NOT_APPLIED', message: '封面上传后未确认应用状态' } },
    });
    expect(diagnosis.title).toContain('头条号封面');
    expect(diagnosis.stage).toBe('fill_cover');
    expect(diagnosis.nextAction).toContain('展示封面');
  });

  it('blocks retry advice for an uncertain result', () => {
    const diagnosis = buildDistributionDiagnosis({
      platform: 'toutiao', status: 'result_uncertain',
      payload: { mode: 'publish', evidence: { stage: 'result_check', message: '草稿已保存' } },
    });
    expect(diagnosis.title).toContain('待确认');
    expect(diagnosis.retry).toContain('禁止');
  });

  it('classifies quota messages even when the platform used an unstructured error', () => {
    const diagnosis = buildDistributionDiagnosis({
      platform: 'penguin', status: 'failed',
      payload: { error: { code: 'DISTRIBUTION_FAILED', message: '今日发文额度已用尽' } },
    });
    expect(diagnosis.title).toContain('额度');
    expect(diagnosis.retry).toContain('不要重试');
  });

  it('explains that a Sohu content fill failure happened before publishing', () => {
    const diagnosis = buildDistributionDiagnosis({
      platform: 'sohu', status: 'failed',
      payload: { mode: 'fill', error: { code: 'SOHU_CONTENT_FILL_FAILED', message: 'title=false, body=false' } },
    });
    expect(diagnosis.title).toContain('编辑器');
    expect(diagnosis.nextAction).toContain('标题输入框');
    expect(diagnosis.retry).toContain('没有点击发布');
  });

  it('creates a copyable plain-text report', () => {
    const report = distributionDiagnosisText({ platform: 'sohu', status: 'success', title: '测试文章' });
    expect(report).toContain('GEO Publisher 分发诊断');
    expect(report).toContain('搜狐号已确认发布');
  });
});
