import { copyFile, rename, rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceFile } from './replace-file.js';

vi.mock('node:fs/promises', () => ({ copyFile: vi.fn(), rename: vi.fn(), rm: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('replace file', () => {
  it('uses atomic rename when available', async () => {
    await replaceFile('source.tmp', 'destination.json');
    expect(rename).toHaveBeenCalledWith('source.tmp', 'destination.json');
    expect(copyFile).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('copies before removing the source when rename reports EXDEV', async () => {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('rename failed'), { code: 'EXDEV' }));
    vi.mocked(copyFile).mockImplementationOnce(async () => {
      expect(rm).not.toHaveBeenCalled();
    });
    await replaceFile('source.tmp', 'destination.json');
    expect(copyFile).toHaveBeenCalledWith('source.tmp', 'destination.json');
    expect(rm).toHaveBeenCalledWith('source.tmp');
  });

  it('preserves the source when the fallback copy fails', async () => {
    const failure = Object.assign(new Error('copy failed'), { code: 'EACCES' });
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('rename failed'), { code: 'EXDEV' }));
    vi.mocked(copyFile).mockRejectedValueOnce(failure);
    await expect(replaceFile('source.tmp', 'destination.json')).rejects.toBe(failure);
    expect(rm).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EBUSY', 'ENOENT'])('does not bypass %s errors', async (code) => {
    const failure = Object.assign(new Error('rename failed'), { code });
    vi.mocked(rename).mockRejectedValueOnce(failure);
    await expect(replaceFile('source.tmp', 'destination.json')).rejects.toBe(failure);
    expect(copyFile).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });
});
