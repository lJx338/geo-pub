import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { authFilePath, dataDirectory, discoveryFilePath, isWindowsStoreRuntime } from './runtime-paths.js';

/** On Windows, fs.promises.realpath uses GetFinalPathNameByHandleW through libuv.
 * Resolve actual files, not their merged AppData parent directory: an MSIX app
 * and an external WorkBuddy process can see different files at the same name.
 * Other distributions must keep their existing paths and launch behavior.
 */
export async function externalFilePath(path: string): Promise<string> {
  if (!isWindowsStoreRuntime()) return path;
  try {
    if (!(await stat(path)).isFile()) throw new Error('不是文件');
    return await realpath(path);
  } catch (error) {
    throw new Error(`微软商店版连接文件无法访问：${path}；${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function externalSkillDirectory(path: string): Promise<string> {
  if (!isWindowsStoreRuntime()) return path;
  return dirname(await externalFilePath(join(path, 'SKILL.md')));
}

export async function externalDataDirectory(): Promise<string> {
  if (!isWindowsStoreRuntime()) return dataDirectory();
  const [discovery, token] = await Promise.all([
    externalFilePath(discoveryFilePath()),
    externalFilePath(authFilePath()),
  ]);
  const directory = dirname(discovery);
  if (directory.toLowerCase() !== dirname(token).toLowerCase()) {
    throw new Error('微软商店版的连接信息位于不同数据目录，请完全退出并重新启动应用后再连接 WorkBuddy。');
  }
  return directory;
}
