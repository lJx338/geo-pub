import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isWorkspaceFileUrl } from './workspace-file.js';

describe('workspace file URL identity', () => {
  const html = resolve('RUNNER~1', '工作台 #1', 'index.html');
  const url = pathToFileURL(html).href;

  it('accepts Chromium and Node encodings of the same path', () => {
    const literal = url.replace(/%7e/gi, '~');
    expect(isWorkspaceFileUrl(literal, html)).toBe(true);
    expect(isWorkspaceFileUrl(literal.replace('~', '%7E'), html)).toBe(true);
    expect(isWorkspaceFileUrl(literal.replace('~', '%7e'), html)).toBe(true);
  });

  it('rejects other files, schemes, query strings, fragments and malformed URLs', () => {
    for (const value of [undefined, '', 'not a URL', 'https://example.com/index.html',
      pathToFileURL(resolve('other', 'index.html')).href, `${url}?other=1`, `${url}#other`,
      url.replace('index.html', '%2Findex.html'), url.replace('index.html', '%ZZ')]) {
      expect(isWorkspaceFileUrl(value, html), value).toBe(false);
    }
  });

  it('does not decode a literal percent escape twice', () => {
    const literalPercentPath = resolve('RUNNER%7E1', 'index.html');
    expect(isWorkspaceFileUrl(pathToFileURL(literalPercentPath).href, literalPercentPath)).toBe(true);
    expect(isWorkspaceFileUrl(pathToFileURL(resolve('RUNNER~1', 'index.html')).href, literalPercentPath)).toBe(false);
  });
});
