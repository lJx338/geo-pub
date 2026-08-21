import { describe, expect, it } from 'vitest';
import { publishingDefaultsSchema, resolveBaijiaSettings } from './platform-settings.js';

describe('platform publishing settings', () => {
  it('keeps safe built-in defaults for existing projects', () => {
    expect(publishingDefaultsSchema.parse(undefined).baijia).toEqual({
      smartCreation: [], declarations: ['aiGenerated'], sourceDate: '', sourceLocation: '',
    });
  });

  it('lets a one-shot override win without changing other project defaults', () => {
    const resolved = resolveBaijiaSettings({
      baijia: { smartCreation: ['autoPodcast'], declarations: ['aiGenerated'], sourceDate: '', sourceLocation: '' },
    }, { declarations: [] });
    expect(resolved).toEqual({
      smartCreation: ['autoPodcast'], declarations: [], sourceDate: '', sourceLocation: '',
    });
  });

  it('requires source details only when source declaration is selected', () => {
    expect(() => resolveBaijiaSettings(undefined, { declarations: ['source'] })).toThrow();
    expect(resolveBaijiaSettings(undefined, { declarations: ['source'], sourceDate: '2026-08-20', sourceLocation: '河北省 / 沧州市' }).declarations).toEqual(['source']);
  });
});
