import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticError } from './diagnostics.js';
import { recordMaterialSaveFailure, recordMaterialSaveRecovery } from './material-diagnostics.js';

const recoverablePathErrors = new Set(['ENOENT', 'ENOTDIR', 'EEXIST', 'EACCES', 'EPERM']);

export function materialDirectories(root: string, projectId: string): [string, string] {
  return [join(root, projectId, 'materials'), join(root, 'material-storage', projectId)];
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code || 'UNKNOWN';
}

export async function storeMaterialFile(root: string, projectId: string, fileName: string, bytes: Buffer): Promise<string> {
  let originalCode = '';
  for (const [index, directory] of materialDirectories(root, projectId).entries()) {
    const destination = join(directory, fileName);
    let stage: 'mkdir' | 'write' = 'mkdir';
    try {
      await mkdir(directory, { recursive: true });
      stage = 'write';
      // Save the bytes already read and hashed, even if the selected file moves.
      await writeFile(destination, bytes);
      if (index > 0) recordMaterialSaveRecovery(root, projectId, destination);
      return destination;
    } catch (error) {
      const code = errorCode(error);
      diagnosticError('[material-storage] ' + JSON.stringify({ projectId, directory, code, syscall: (error as NodeJS.ErrnoException)?.syscall, message: String(error) }));
      await recordMaterialSaveFailure(root, projectId, directory, destination, stage, error);
      if (index === 0 && recoverablePathErrors.has(code)) {
        // Preserve conflicting files and junctions. Keep the fallback beside
        // the content database so it remains persistent across app restarts.
        originalCode = code;
        continue;
      }
      const reason = code === 'ENOSPC' ? '磁盘空间不足' : ['EACCES', 'EPERM'].includes(code) ? '没有写入权限' : '素材保存目录无法写入';
      const codes = originalCode ? originalCode + ' / ' + code : code;
      throw new Error('MATERIAL_STORAGE_UNAVAILABLE: 添加素材失败：' + reason + '（' + codes + '）。请检查应用数据目录的访问权限和磁盘状态后重试，也可在“设置 → 排障与本地数据”导出诊断日志。', { cause: error });
    }
  }
  throw new Error('MATERIAL_STORAGE_UNAVAILABLE: 找不到可用的素材保存目录');
}
