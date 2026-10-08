import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// Both file-picker and WorkBuddy imports stay available after restart and never require
// an inherited child process to use a temporary file-picker permission.
export async function persistSandboxFile(dataDir: string, bytes: Buffer, original: string): Promise<string> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const directory = join(dataDir, 'bridge-imports', hash);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = basename(original).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-160);
  const destination = join(directory, !name || name === '.' || name === '..' ? 'input' : name);
  await writeFile(destination, bytes, { mode: 0o600 });
  return destination;
}
