import { copyFile, rename, rm } from 'node:fs/promises';

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
}

/**
 * Replaces a file atomically when the filesystem supports it. Some Windows
 * encrypted or redirected directories report EXDEV even for sibling paths;
 * fall back to a copy only for that explicit condition.
 */
export async function replaceFile(temporary: string, destination: string): Promise<void> {
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await copyFile(temporary, destination);
    await rm(temporary, { force: true });
  }
}
