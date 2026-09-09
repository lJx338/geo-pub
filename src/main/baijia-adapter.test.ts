import { describe, expect, it } from 'vitest';
import { baijiaCoverUploadFormat } from './baijia-adapter.js';

describe('Baijia cover upload format', () => {
  it('uploads formats accepted by Baijia without conversion', () => {
    expect(baijiaCoverUploadFormat('cover.jpg')).toBe('original');
    expect(baijiaCoverUploadFormat('cover.JPEG')).toBe('original');
    expect(baijiaCoverUploadFormat('cover.png')).toBe('original');
  });

  it('converts WebP covers to PNG before upload', () => {
    expect(baijiaCoverUploadFormat('cover.webp')).toBe('convert-webp');
    expect(baijiaCoverUploadFormat('cover.WEBP')).toBe('convert-webp');
  });

  it('rejects formats that cannot be converted safely', () => {
    expect(baijiaCoverUploadFormat('cover.gif')).toBe('unsupported');
    expect(baijiaCoverUploadFormat('cover')).toBe('unsupported');
  });
});
