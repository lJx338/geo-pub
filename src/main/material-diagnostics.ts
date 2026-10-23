import { constants } from 'node:fs';
import { access, lstat, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StartupLog } from './startup-log.js';

const logs = new Map<string, StartupLog>();

function logFor(root: string): StartupLog {
  const key = resolve(root);
  let log = logs.get(key);
  if (!log) {
    const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
    log = new StartupLog([join(dirname(key), 'diagnostics'), join(tmpdir(), 'lingxi-material-diagnostics', id)], 'materials.log');
    logs.set(key, log);
  }
  return log;
}

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code || 'UNKNOWN';
}

export async function inspectDirectory(path: string) {
  const result = {
    path, exists: null as boolean | null, isLink: null as boolean | null,
    isDirectory: null as boolean | null, targetExists: null as boolean | null,
    resolvedPath: null as string | null, linkTarget: null as string | null, writable: null as boolean | null,
    errorCode: null as string | null, targetErrorCode: null as string | null,
    writeAccessErrorCode: null as string | null,
  };
  try {
    const entry = await lstat(path);
    result.exists = true;
    result.isLink = entry.isSymbolicLink();
    if (result.isLink) {
      try { result.linkTarget = await readlink(path); } catch { /* link may have changed */ }
    }
    try {
      const target = await stat(path);
      result.targetExists = true;
      result.isDirectory = target.isDirectory();
      result.resolvedPath = await realpath(path);
    } catch (error) {
      result.targetErrorCode = codeOf(error);
      result.targetExists = ['ENOENT', 'ENOTDIR'].includes(result.targetErrorCode) ? false : null;
    }
    try {
      await access(path, constants.W_OK);
      result.writable = true;
    } catch (error) {
      result.writable = false;
      result.writeAccessErrorCode = codeOf(error);
    }
  } catch (error) {
    result.errorCode = codeOf(error);
    result.exists = ['ENOENT', 'ENOTDIR'].includes(result.errorCode) ? false : null;
  }
  return result;
}

export async function inspectDirectoryChain(directory: string) {
  const paths: string[] = [];
  for (let current = resolve(directory); ; current = dirname(current)) {
    paths.push(current);
    if (dirname(current) === current) break;
  }
  return Promise.all(paths.reverse().map(inspectDirectory));
}

export async function recordMaterialSaveFailure(root: string, projectId: string, directory: string, destination: string, stage: 'mkdir' | 'write', error: unknown): Promise<void> {
  try {
    const directories = await inspectDirectoryChain(directory);
    logFor(root).record('material.save-failed', {
      projectId, destination, stage, code: codeOf(error),
      syscall: (error as NodeJS.ErrnoException | null)?.syscall ?? null,
      directories,
    });
  } catch {
    // A diagnostic failure must not stop the fallback from saving the image.
  }
}

export function recordMaterialSaveRecovery(root: string, projectId: string, destination: string): void {
  try { logFor(root).record('material.save-recovered', { projectId, destination }); } catch { /* best effort */ }
}

export async function writeMaterialDiagnosticReport(destination: string, root: string, runtime: Record<string, unknown>): Promise<void> {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    app: runtime,
    storage: { contentDirectory: root, directories: await inspectDirectoryChain(root) },
    recentLog: logFor(root).report('Lingxi Workspace 素材诊断'),
    notes: '包含本机保存路径和近期素材保存诊断，不包含图片内容、文章正文、Cookie 或 Token。writable 是系统写权限检查结果，不保证实际写入成功；null 表示无法判断。目录检查发生在失败之后。',
  };
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}
