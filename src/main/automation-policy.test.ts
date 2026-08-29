import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainDirectory = dirname(fileURLToPath(import.meta.url));
const adapters = [
  'baijia-adapter.ts',
  'netease-adapter.ts',
  'penguin-adapter.ts',
  'publish-adapter.ts',
  'sohu-adapter.ts',
  'toutiao-adapter.ts',
  'zhihu-adapter.ts',
  'editor-draft.ts',
];

describe('browser automation policy', () => {
  it('keeps Electron system input and clipboard out of publishing adapters', async () => {
    const source = await Promise.all(adapters.map(async (file) => await readFile(join(mainDirectory, file), 'utf8')));
    expect(source.join('\n')).not.toMatch(/sendInputEvent|webContents\.paste\(|clipboard.*from 'electron'|webContents\.focus\(/);
  });
});
