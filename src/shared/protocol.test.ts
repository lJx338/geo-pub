import { describe, expect, it } from 'vitest';
import { controlRequestSchema } from './protocol.js';

const document = {
  title: '正常文章标题',
  blocks: [{ type: 'paragraph' as const, text: '正文内容' }],
};

describe('control protocol', () => {
  it('accepts a valid status request', () => {
    expect(controlRequestSchema.safeParse({ id: '1', token: 'x'.repeat(32), action: 'status' }).success).toBe(true);
  });

  it('rejects unsupported platforms', () => {
    expect(controlRequestSchema.safeParse({
      id: '1', token: 'x'.repeat(32), action: 'platform.open', platform: 'unknown',
    }).success).toBe(false);
  });

  it('limits Toutiao titles before opening the browser', () => {
    expect(controlRequestSchema.safeParse({
      id: '1', token: 'x'.repeat(32), action: 'draft.fill', platform: 'toutiao', document: { ...document, title: 'a'.repeat(31) }, coverPath: '/tmp/cover.jpg',
    }).success).toBe(false);
  });

  it('requires an explicit confirmation for real publishing', () => {
    const base = { id: '1', token: 'x'.repeat(32), action: 'draft.publish', platform: 'sohu', document, coverPath: '' };
    expect(controlRequestSchema.safeParse(base).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...base, confirmPublish: true }).success).toBe(true);
  });

  it('requires a structured document instead of legacy HTML fields', () => {
    expect(controlRequestSchema.safeParse({
      id: '1', token: 'x'.repeat(32), action: 'draft.fill', platform: 'zhihu',
      title: '旧标题', html: '<p>旧正文</p>', coverPath: '',
    }).success).toBe(false);
  });
});
