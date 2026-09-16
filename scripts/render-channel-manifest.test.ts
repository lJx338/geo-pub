import { describe, expect, it } from 'vitest';
import { renderChannelManifest } from './render-channel-manifest.mjs';

describe('release channel manifest', () => {
  it('points old update feeds at immutable version artifacts', () => {
    const rendered = renderChannelManifest(`
version: 0.2.1
files:
  - url: GEO Publisher-0.2.1-win-x64.exe
    sha512: abc
path: GEO Publisher-0.2.1-win-x64.exe
sha512: abc
`, 'https://download.example/releases/versions/0.2.1/win-x64');

    expect(rendered).toContain('version: 0.2.1');
    expect(rendered).toContain('https://download.example/releases/versions/0.2.1/win-x64/GEO%20Publisher-0.2.1-win-x64.exe');
  });

  it('does not double encode artifact names', () => {
    const rendered = renderChannelManifest(`
version: 0.2.1
files:
  - url: GEO%20Publisher-0.2.1-mac-arm64.zip
    sha512: abc
`, 'https://download.example/releases/versions/0.2.1/mac-arm64');

    expect(rendered).toContain('GEO%20Publisher-0.2.1-mac-arm64.zip');
    expect(rendered).not.toContain('%2520');
  });
});
