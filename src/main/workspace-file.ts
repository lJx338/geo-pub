import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Chromium and Node can encode the same file URL differently (e.g. ~ / %7E). */
export function isWorkspaceFileUrl(value: string | undefined, htmlPath: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.search || url.hash) return false;
    return fileURLToPath(url) === resolve(htmlPath);
  } catch {
    return false;
  }
}
