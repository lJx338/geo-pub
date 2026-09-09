import { copyFile, rename, rm } from 'node:fs/promises';

export async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EXDEV') throw error;
    await copyFile(source, destination);
    await rm(source);
  }
}
