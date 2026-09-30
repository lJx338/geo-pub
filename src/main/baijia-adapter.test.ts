import { describe, expect, it } from 'vitest';
import { baijiaCoverUploadFormat } from './baijia-adapter.js';

describe('Baijia cover compatibility', () => {
  it('passes Baijia-supported cover formats through unchanged', () => {
    expect(baijiaCoverUploadFormat('cover.jpg')).toBe('original');
    expect(baijiaCoverUploadFormat('cover.JPEG')).toBe('original');
    expect(baijiaCoverUploadFormat('cover.png')).toBe('original');
  });

  it('converts WebP covers before upload', () => {
    expect(baijiaCoverUploadFormat('cover.webp')).toBe('convert-webp');
    expect(baijiaCoverUploadFormat('cover.WEBP')).toBe('convert-webp');
  });

  it('rejects formats that Baijia cannot accept', () => {
    expect(baijiaCoverUploadFormat('cover.gif')).toBe('unsupported');
    expect(baijiaCoverUploadFormat('cover')).toBe('unsupported');
  });
});
