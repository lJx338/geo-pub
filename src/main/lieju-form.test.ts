import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { liejuFormUrl, parseLiejuFormOptions } from './lieju-form.js';
import { defaultLiejuSettings, publishingDefaultsSchema, resolveLiejuSettings } from '../shared/platform-settings.js';
import { desktopDistributionRequestSchema, controlRequestSchema } from '../shared/protocol.js';

const fixture = readFileSync('tests/fixtures/lieju-form.html', 'utf8');
describe('Lieju settings and public form discovery', () => {
  it('extracts real select values and required fields without leaking other form fields', () => {
    const { fields } = parseLiejuFormOptions(fixture);
    expect(fields.map(field => field.id)).toEqual(['atc_zone_id', 'atc_leibie', 'atc_danjia', 'atc_gongsi', 'atc_mobphone', 'atc_linkman']);
    expect(fields.find(field => field.id === 'atc_zone_id')?.options).toEqual([{ value: '295', label: '莞城' }, { value: '296', label: '南城' }]);
    expect(fields.every(field => field.required)).toBe(true);
    expect(() => parseLiejuFormOptions('<html>登录页面</html>')).toThrow('LIEJU_FORM_UNAVAILABLE');
  });
  it('only builds posting URLs from numeric IDs', () => {
    expect(liejuFormUrl('21', '247')).toBe('https://post.lieju.com/21/247');
    for (const value of ['', '0', '../member', '21?x', 'https://other.test']) expect(() => liejuFormUrl(value, '247')).toThrow();
  });
  it('keeps old projects valid and resolves isolated project defaults', () => {
    const original = publishingDefaultsSchema.parse(undefined);
    expect(resolveLiejuSettings(original).price).toBe('1');
    const projectA = { ...original, lieju: { ...defaultLiejuSettings, company: '客户甲', price: '12' } };
    expect(resolveLiejuSettings(projectA, { price: '2' }).company).toBe('客户甲');
    expect(resolveLiejuSettings(projectA, { price: '2' }).price).toBe('2');
    expect(projectA.lieju.price).toBe('12');
    expect(resolveLiejuSettings(original).company).toBe('');
    expect(() => resolveLiejuSettings(original, { price: '0' })).toThrow();
  });
  it('rejects auto-publish at both desktop and CLI protocol boundaries', () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    expect(desktopDistributionRequestSchema.safeParse({ projectId, articleId: 'a', platforms: ['lieju'], mode: 'publish', confirmPublish: true }).success).toBe(false);
    const request = { id: 'a', token: 'x'.repeat(32), projectId, platform: 'lieju', document: { title: '如何选择合适的配件', blocks: [{ type: 'paragraph', text: '先核对规格和使用环境，再确认配件质量。' }] }, confirmPublish: true };
    expect(controlRequestSchema.safeParse({ ...request, action: 'draft.publish' }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...request, action: 'draft.fill' }).success).toBe(true);
    expect(controlRequestSchema.safeParse({ ...request, action: 'draft.fill', document: { ...request.document, title: '短标题' } }).success).toBe(false);
  });
});
