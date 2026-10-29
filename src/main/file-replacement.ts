import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { copyFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

function stagingPath(destination: string): string {
  return join(dirname(destination), `.replace-${randomUUID()}.tmp`);
}

/** Move a regular file, replacing the destination only after its bytes are ready.
 * MSIX can redirect sibling AppData files to different volumes. On EXDEV, stage
 * a copy at the destination and resolve the actual FILE (a merged parent path
 * need not identify the write location). Commit using physical sibling paths.
 * Never copy directly over the destination: a failed copy would corrupt it.
 * Other errors, including locked files and denied access, must still propagate.
 * As with rename, this does not guarantee durability against power loss.
 */
export async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!hasCode(error, 'EXDEV')) throw error;
  }

  // Do not resolve an existing destination: MSIX may read it from the real
  // profile while redirecting new writes to a different package volume.
  const staging = stagingPath(destination);
  let cleanup = staging;
  let copied = false;
  try {
    await copyFile(source, staging, constants.COPYFILE_EXCL);
    copied = true;
    cleanup = await realpath(staging);
    await rename(cleanup, join(dirname(cleanup), basename(destination)));
  } finally {
    // copyFile removes its own incomplete output on failure. Do not remove a
    // pre-existing file if the exclusive copy failed with EEXIST.
    if (copied) await unlink(cleanup).catch(() => undefined);
  }
  await unlink(source);
}

/** Synchronous equivalent for startup logging and SQLite repair transactions. */
export function replaceFileSync(source: string, destination: string): void {
  try {
    renameSync(source, destination);
    return;
  } catch (error) {
    if (!hasCode(error, 'EXDEV')) throw error;
  }

  const staging = stagingPath(destination);
  let cleanup = staging;
  let copied = false;
  try {
    copyFileSync(source, staging, constants.COPYFILE_EXCL);
    copied = true;
    cleanup = realpathSync(staging);
    renameSync(cleanup, join(dirname(cleanup), basename(destination)));
  } finally {
    if (copied) {
      try { unlinkSync(cleanup); } catch { /* Preserve the original failure. */ }
    }
  }
  unlinkSync(source);
}
