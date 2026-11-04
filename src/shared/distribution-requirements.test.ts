import { describe, expect, it } from 'vitest';
import { assertRequiredFillFields, distributionInputIssues } from './distribution-requirements.js';
import { controlRequestSchema, PLATFORMS } from './protocol.js';

const document = { title: '校验测试文章', blocks: [{ type: 'paragraph', text: '正文' }], tags: ['化工'] };
const request = { id: '1', token: 'x'.repeat(32), projectId: '11111111-1111-4111-8111-111111111111', document, confirmPublish: true };

describe('required publishing fields', () => {
  it.each(PLATFORMS)('%s requires cover in both fill and publish requests', platform => {
    for (const action of ['draft.fill', 'draft.publish']) {
      for (const coverPath of ['', '   ']) {
        expect(controlRequestSchema.safeParse({ ...request, action, platform, coverPath }).success).toBe(false);
      }
      expect(controlRequestSchema.safeParse({ ...request, action, platform, coverPath: '/tmp/cover.jpg' }).success).toBe(true);
    }
  });

  it.each([[], ['#', '＃'], [' # ＃ ']].map(tags => ({ tags })))('rejects missing/empty normalized Zhihu topics: %j', ({ tags }) => {
    expect(distributionInputIssues(['zhihu'], tags, '/tmp/cover.jpg')[0]?.code).toBe('ZHIHU_TOPICS_REQUIRED');
    for (const action of ['draft.fill', 'draft.publish']) {
      expect(controlRequestSchema.safeParse({ ...request, document: { ...document, tags }, action, platform: 'zhihu', coverPath: '/tmp/cover.jpg' }).success).toBe(false);
    }
    expect(distributionInputIssues(['penguin', 'sohu'], tags, '/tmp/cover.jpg')).toEqual([]);
  });

  it.each(['zhihu', 'penguin', 'sohu'])('does not accept missing/skipped/unapplied %s covers', platform => {
    for (const cover of [{}, { coverUploaded: false, coverStatus: 'skipped' }, { coverUploaded: true }, { coverUploaded: false, coverStatus: 'applied' }]) {
      expect(() => assertRequiredFillFields(platform, { ...cover, topicsApplied: ['化工'] })).toThrow('COVER_NOT_APPLIED');
    }
  });

  it('requires a verified native topic instead of a requested tag or a success flag', () => {
    const cover = { coverUploaded: true, coverStatus: 'applied' };
    expect(() => assertRequiredFillFields('zhihu', { ...cover, topicsRequested: ['化工'], topicsVerified: true, topicsApplied: [] })).toThrow('ZHIHU_TOPICS_NOT_SELECTED');
    expect(() => assertRequiredFillFields('zhihu', { ...cover, topicsApplied: ['#'] })).toThrow('ZHIHU_TOPICS_NOT_SELECTED');
    expect(() => assertRequiredFillFields('zhihu', { ...cover, topicsApplied: ['CNC加工'], topicsVerified: false, topicsUnmatched: ['其余话题'] })).not.toThrow();
    expect(() => assertRequiredFillFields('penguin', cover)).not.toThrow();
    expect(() => assertRequiredFillFields('sohu', cover)).not.toThrow();
  });
});
