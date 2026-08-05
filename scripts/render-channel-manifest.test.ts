import { describe, expect, it } from 'vitest';
// The release utility is JavaScript so GitHub Actions can invoke it directly.
// @ts-expect-error The utility intentionally has no separate declaration file.
import { renderChannelManifest } from './render-channel-manifest.mjs';
import { parse } from 'yaml';

describe('renderChannelManifest', () => {
  it('points channel entries at immutable version artifacts', () => {
    const rendered = renderChannelManifest(`
version: 0.2.0
files:
  - url: GEO Publisher-0.2.0-win-x64.exe
    sha512: checksum
    size: 123
path: GEO Publisher-0.2.0-win-x64.exe
sha512: checksum
`, 'https://download.example/releases/versions/0.2.0/win-x64');

    const manifest = parse(rendered);
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.files[0].url).toBe(
      'https://download.example/releases/versions/0.2.0/win-x64/GEO%20Publisher-0.2.0-win-x64.exe',
    );
    expect(manifest.path).toBe('GEO Publisher-0.2.0-win-x64.exe');
  });

  it('does not encode an already rendered artifact URL again', () => {
    const first = renderChannelManifest(`
version: 0.2.0
files:
  - url: GEO Publisher-0.2.0-win-x64.exe
    sha512: checksum
`, 'https://download.example/releases/versions/0.2.0/win-x64');
    const second = renderChannelManifest(
      first,
      'https://download.example/releases/versions/0.2.0/win-x64',
    );

    expect(parse(second).files[0].url).toBe(
      'https://download.example/releases/versions/0.2.0/win-x64/GEO%20Publisher-0.2.0-win-x64.exe',
    );
  });

  it('rejects malformed manifests', () => {
    expect(() => renderChannelManifest('version: 0.2.0\n', 'https://download.example')).toThrow(
      'does not contain any files',
    );
  });
});
