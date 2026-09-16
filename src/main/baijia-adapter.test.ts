import { describe, expect, it } from 'vitest';
import { baijiaCoverUploadFormat, shouldReloadBaijiaEditorAfterFill, shouldRetryBaijiaContentFill } from './baijia-adapter.js';

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

describe('Baijia editor stabilization', () => {
  it('retries only an incomplete editor read and keeps the retry budget bounded', () => {
    expect(shouldRetryBaijiaContentFill(true, false, 0)).toBe(true);
    expect(shouldRetryBaijiaContentFill(false, false, 3)).toBe(true);
    expect(shouldRetryBaijiaContentFill(true, true, 0)).toBe(false);
    expect(shouldRetryBaijiaContentFill(true, false, 4)).toBe(false);
  });

  it('reloads a stale editor once when the body still did not persist', () => {
    expect(shouldReloadBaijiaEditorAfterFill(false, 0)).toBe(true);
    expect(shouldReloadBaijiaEditorAfterFill(false, 1)).toBe(false);
    expect(shouldReloadBaijiaEditorAfterFill(true, 0)).toBe(false);
  });
});
