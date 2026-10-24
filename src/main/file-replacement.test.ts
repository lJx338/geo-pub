import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceFile, replaceFileSync } from './file-replacement.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), copyFileSync: vi.fn(actual.copyFileSync) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), copyFile: vi.fn(actual.copyFile) };
});
const actualFs = await vi.importActual<typeof fs>('node:fs');
const actualFsp = await vi.importActual<typeof fsp>('node:fs/promises');
const failure = (code: string) => Object.assign(new Error(code), { code });
let root: string, logical: string, physical: string, source: string, destination: string;

beforeEach(() => {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actualFs.renameSync);
  vi.mocked(fs.copyFileSync).mockReset().mockImplementation(actualFs.copyFileSync);
  vi.mocked(fsp.rename).mockReset().mockImplementation(actualFsp.rename);
  vi.mocked(fsp.copyFile).mockReset().mockImplementation(actualFsp.copyFile);
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'geo-replace-')));
  physical = join(root, 'package-profile');
  logical = join(root, 'virtual-profile');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, logical, 'junction');
  source = join(logical, 'record.new');
  destination = join(logical, 'record');
  fs.writeFileSync(source, 'complete new data', { mode: 0o600 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

for (const mode of ['async', 'sync'] as const) {
  const move = async () => mode === 'async' ? await replaceFile(source, destination) : replaceFileSync(source, destination);
  const rename = () => mode === 'async' ? vi.mocked(fsp.rename) : vi.mocked(fs.renameSync);
  const copy = () => mode === 'async' ? vi.mocked(fsp.copyFile) : vi.mocked(fs.copyFileSync);
  function redirectRenames() {
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      if (String(from).startsWith(logical) || String(to).startsWith(logical)) throw failure('EXDEV');
      await actualFsp.rename(from, to);
    });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).startsWith(logical) || String(to).startsWith(logical)) throw failure('EXDEV');
      actualFs.renameSync(from, to);
    });
  }

  describe(`${mode} file replacement`, () => {
    it('uses a single rename when supported', async () => {
      await move();
      expect(fs.readFileSync(destination, 'utf8')).toBe('complete new data');
      expect(fs.existsSync(source)).toBe(false);
      expect(rename()).toHaveBeenCalledTimes(1);
      expect(copy()).not.toHaveBeenCalled();
    });

    it.each([false, true])('commits through physical paths after EXDEV (existing target: %s)', async exists => {
      if (exists) fs.writeFileSync(destination, 'old data');
      redirectRenames();
      await move();
      expect(fs.readFileSync(destination, 'utf8')).toBe('complete new data');
      expect(fs.readdirSync(physical)).toEqual(['record']);
      if (process.platform !== 'win32') expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
      expect(rename()).toHaveBeenLastCalledWith(expect.stringContaining(physical), join(physical, 'record'));
    });

    it('replaces the destination entry in the write location without following an old target alias', async () => {
      const other = join(root, 'other-volume');
      fs.mkdirSync(other);
      const target = join(other, 'record');
      fs.writeFileSync(target, 'old data');
      fs.symlinkSync(target, destination);
      redirectRenames();
      await move();
      expect(fs.readFileSync(target, 'utf8')).toBe('old data');
      expect(fs.readFileSync(destination, 'utf8')).toBe('complete new data');
      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
      expect(fs.readdirSync(other)).toEqual(['record']);
      expect(rename()).toHaveBeenLastCalledWith(expect.stringContaining(physical), join(physical, 'record'));
    });

    it.each(['EACCES', 'EPERM', 'EBUSY', 'ENOENT'])('does not hide %s or delete the destination', async code => {
      fs.writeFileSync(destination, 'old data');
      const error = failure(code);
      rename().mockImplementationOnce(() => { throw error; });
      await expect(move()).rejects.toBe(error);
      expect(copy()).not.toHaveBeenCalled();
      expect(fs.readFileSync(destination, 'utf8')).toBe('old data');
      expect(fs.readFileSync(source, 'utf8')).toBe('complete new data');
    });

    it('preserves both original files when the copy fails', async () => {
      fs.writeFileSync(destination, 'old data');
      redirectRenames();
      const error = failure('ENOSPC');
      copy().mockImplementationOnce(() => { throw error; });
      await expect(move()).rejects.toBe(error);
      expect(fs.readFileSync(destination, 'utf8')).toBe('old data');
      expect(fs.readFileSync(source, 'utf8')).toBe('complete new data');
      expect(fs.readdirSync(physical).sort()).toEqual(['record', 'record.new']);
    });

    it('cleans staging and preserves the previous target if the final commit fails', async () => {
      fs.writeFileSync(destination, 'old data');
      rename().mockImplementationOnce(() => { throw failure('EXDEV'); });
      const error = failure('EBUSY');
      rename().mockImplementationOnce(() => { throw error; });
      await expect(move()).rejects.toBe(error);
      expect(fs.readFileSync(destination, 'utf8')).toBe('old data');
      expect(fs.readFileSync(source, 'utf8')).toBe('complete new data');
      expect(fs.readdirSync(physical).sort()).toEqual(['record', 'record.new']);
    });
  });
}
