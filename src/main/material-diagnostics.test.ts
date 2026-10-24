import { access, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectDirectory, inspectDirectoryChain, recordMaterialSaveFailure, recordMaterialSaveRecovery, writeMaterialDiagnosticReport } from './material-diagnostics.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, access: vi.fn(actual.access), lstat: vi.fn(actual.lstat), stat: vi.fn(actual.stat) };
});

const roots: string[] = [];
async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-material-diagnostics-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('material failure diagnostics', () => {
  it('distinguishes a directory, a conflicting file, and a missing directory', async () => {
    const root = await temporaryDirectory();
    const file = join(root, 'conflict');
    await writeFile(file, 'private image content');
    expect(await inspectDirectory(root)).toMatchObject({ exists: true, isDirectory: true, isLink: false, writable: true, errorCode: null });
    expect(await inspectDirectory(file)).toMatchObject({ exists: true, isDirectory: false, isLink: false, writable: false });
    expect(await inspectDirectory(join(root, 'missing'))).toMatchObject({ exists: false, writable: false, errorCode: 'ENOENT' });
  });

  it('records a broken link and its target instead of claiming the link is missing', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'missing-target');
    const link = join(root, 'broken-link');
    await symlink(target, link, 'junction');
    expect(await inspectDirectory(link)).toMatchObject({ exists: true, isLink: true, targetExists: false, targetErrorCode: 'ENOENT', writable: false });
    expect((await inspectDirectory(link)).linkTarget).toContain('missing-target');
    expect(access).not.toHaveBeenCalled();
  });

  it('checks write access for an existing directory target', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    const link = join(root, 'link');
    await mkdir(target);
    await symlink(target, link, 'junction');
    expect(await inspectDirectory(link)).toMatchObject({ exists: true, isLink: true, targetExists: true, isDirectory: true, writable: true });
    expect(access).toHaveBeenCalled();
  });

  it('leaves writability unknown when target inspection or access fails unexpectedly', async () => {
    const root = await temporaryDirectory();
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await inspectDirectory(root)).toMatchObject({ exists: true, targetExists: null, writable: null, targetErrorCode: 'EACCES' });
    expect(access).not.toHaveBeenCalled();
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error('I/O failure'), { code: 'EIO' }));
    expect(await inspectDirectory(root)).toMatchObject({ exists: true, writable: null, writeAccessErrorCode: 'EIO' });
  });

  it('keeps inaccessible paths unknown and records denied write checks', async () => {
    const root = await temporaryDirectory();
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await inspectDirectory(root)).toMatchObject({ exists: null, isLink: null, writable: null, errorCode: 'EACCES' });
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await inspectDirectory(root)).toMatchObject({ exists: true, writable: false, writeAccessErrorCode: 'EACCES' });
  });

  it('inspects every ancestor up to the filesystem root', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'missing', 'materials');
    const chain = await inspectDirectoryChain(path);
    expect(chain.at(-1)).toMatchObject({ path, exists: false });
    expect(chain.some((entry) => entry.path === root && entry.exists)).toBe(true);
    expect(dirname(chain[0]!.path)).toBe(chain[0]!.path);
    for (let i = 1; i < chain.length; i++) expect(dirname(chain[i]!.path)).toBe(chain[i - 1]!.path);
  });

  it('persists the exact failure and recovery paths and exports them after a logger reload', async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, 'content');
    const destination = join(root, 'project', 'materials', 'image.jpg');
    const recovered = join(root, 'material-storage', 'project', 'image.jpg');
    await mkdir(root);
    await writeFile(join(directory, 'private.jpg'), 'PRIVATE_IMAGE_BYTES');
    await recordMaterialSaveFailure(root, 'project', dirname(destination), destination, 'mkdir', Object.assign(new Error('not found'), { code: 'ENOENT', syscall: 'mkdir' }));
    recordMaterialSaveRecovery(root, 'project', recovered);
    const lines = (await readFile(join(directory, 'diagnostics', 'materials.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ event: 'material.save-failed', details: { destination, stage: 'mkdir', code: 'ENOENT', syscall: 'mkdir' } });
    expect(lines[0].details.directories.at(-1)).toMatchObject({ path: dirname(destination), exists: false });
    expect(lines[1]).toMatchObject({ event: 'material.save-recovered', details: { destination: recovered } });

    vi.resetModules();
    const reloaded = await import('./material-diagnostics.js');
    const output = join(directory, 'report.json');
    await reloaded.writeMaterialDiagnosticReport(output, root, { version: 'test-version', platform: process.platform });
    const reportText = await readFile(output, 'utf8');
    const report = JSON.parse(reportText);
    expect(report).toMatchObject({ schemaVersion: 1, app: { version: 'test-version' }, storage: { contentDirectory: root } });
    const exportedEntries = report.recentLog.split('\n').slice(2).filter(Boolean).map((line: string) => JSON.parse(line));
    expect(exportedEntries[0].details.destination).toBe(destination);
    expect(exportedEntries[1].details.destination).toBe(recovered);
    expect(reportText).not.toContain('PRIVATE_IMAGE_BYTES');
    expect(report.storage.directories.at(-1).resolvedPath).toBe(await import('node:fs/promises').then((fs) => fs.realpath(root)));
  });

  it('exports a useful current snapshot even before a material failure has occurred', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'report.json');
    const root = join(directory, 'content');
    await writeMaterialDiagnosticReport(output, root, { version: 'test' });
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report.storage.directories.at(-1)).toMatchObject({ path: resolve(root), exists: false });
    expect(report.recentLog).toContain('素材诊断');
  });
});
