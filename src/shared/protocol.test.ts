import { describe, expect, it } from 'vitest';
import { controlRequestSchema } from './protocol.js';

const requestBase = { id: '1', token: 'x'.repeat(32), protocolVersion: 1, clientVersion: '0.2.4' };

describe('control protocol', () => {
  it('accepts a valid status request', () => {
    expect(controlRequestSchema.safeParse({ ...requestBase, action: 'status' }).success).toBe(true);
  });

  it('accepts the released legacy CLI request shape during migration', () => {
    expect(controlRequestSchema.safeParse({ id: '1', token: 'x'.repeat(32), action: 'status' }).success).toBe(true);
  });

  it('rejects unsupported platforms', () => {
    expect(controlRequestSchema.safeParse({
      ...requestBase, action: 'platform.open', platform: 'unknown',
    }).success).toBe(false);
  });

  it('limits Toutiao titles before opening the browser', () => {
    expect(controlRequestSchema.safeParse({
      ...requestBase, action: 'draft.fill', platform: 'toutiao', title: 'a'.repeat(31), html: '<p>x</p>', coverPath: '/tmp/cover.jpg',
    }).success).toBe(false);
  });

  it('requires an explicit confirmation for real publishing', () => {
    const publish = { ...requestBase, action: 'draft.publish', platform: 'sohu', title: '正常文章标题', html: '<p>正文</p>', coverPath: '' };
    expect(controlRequestSchema.safeParse(publish).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...publish, confirmPublish: true }).success).toBe(true);
  });
});
