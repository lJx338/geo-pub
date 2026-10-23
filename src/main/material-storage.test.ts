import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticError } from './diagnostics.js';
import { storeMaterialFile } from './material-storage.js';
import { recordMaterialSaveFailure, recordMaterialSaveRecovery } from './material-diagnostics.js';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock('./diagnostics.js', () => ({ diagnosticError: vi.fn() }));
vi.mock('./material-diagnostics.js', () => ({ recordMaterialSaveFailure: vi.fn(), recordMaterialSaveRecovery: vi.fn() }));

const bytes = Buffer.from('original image bytes');
const root = join('data', 'content');
const primary = join(root, 'project', 'materials');
const fallback = join(root, 'material-storage', 'project');
const failure = (code: string) => Object.assign(new Error(code), { code, syscall: 'mkdir' });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

describe('material storage recovery', () => {
  it('saves the original bytes when the primary mkdir returns the reported ENOENT', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(failure('ENOENT'));
    const path = await storeMaterialFile(root, 'project', 'image.jpg', bytes);
    expect(path).toBe(join(fallback, 'image.jpg'));
    expect(writeFile).toHaveBeenCalledWith(path, bytes);
    expect(diagnosticError).toHaveBeenCalledWith(expect.stringContaining('"code":"ENOENT"'));
    expect(recordMaterialSaveFailure).toHaveBeenCalledWith(root, 'project', primary, join(primary, 'image.jpg'), 'mkdir', expect.objectContaining({ code: 'ENOENT' }));
    expect(recordMaterialSaveRecovery).toHaveBeenCalledWith(root, 'project', path);
  });

  it('recovers when the primary directory exists but writing the image is denied', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(failure('EACCES'));
    const path = await storeMaterialFile(root, 'project', 'image.jpg', bytes);
    expect(path).toBe(join(fallback, 'image.jpg'));
    expect(writeFile).toHaveBeenLastCalledWith(path, bytes);
  });

  it('keeps existing installations using their original material location', async () => {
    expect(await storeMaterialFile(root, 'project', 'image.jpg', bytes)).toBe(join(primary, 'image.jpg'));
    expect(mkdir).toHaveBeenCalledTimes(1);
  });

  it('reports both error codes when neither persistent location is usable', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(failure('ENOENT')).mockRejectedValueOnce(failure('EPERM'));
    await expect(storeMaterialFile(root, 'project', 'image.jpg', bytes)).rejects.toThrow('没有写入权限（ENOENT / EPERM）');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('reports a full disk without trying to write the same image elsewhere on it', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(failure('ENOSPC'));
    await expect(storeMaterialFile(root, 'project', 'image.jpg', bytes)).rejects.toThrow('磁盘空间不足（ENOSPC）');
    expect(mkdir).toHaveBeenCalledTimes(1);
  });
});
