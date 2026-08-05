import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

function encodeArtifactName(value) {
  return String(value)
    .split('/')
    .map((part) => {
      let decoded = part;
      let previous;
      do {
        previous = decoded;
        decoded = decodeURIComponent(decoded);
      } while (decoded !== previous);
      return encodeURIComponent(decoded);
    })
    .join('/');
}

export function renderChannelManifest(source, artifactBaseUrl) {
  const manifest = parse(source);
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
    throw new Error('Update manifest is missing a valid version');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Update manifest does not contain any files');
  }

  const base = artifactBaseUrl.replace(/\/+$/, '');
  manifest.files = manifest.files.map((file) => {
    if (!file || typeof file !== 'object' || typeof file.url !== 'string') {
      throw new Error('Update manifest contains an invalid file entry');
    }
    const artifactName = file.url.split('/').at(-1);
    if (!artifactName) throw new Error('Update manifest contains an empty artifact URL');
    return { ...file, url: `${base}/${encodeArtifactName(artifactName)}` };
  });

  return stringify(manifest, { lineWidth: 0 });
}

async function main() {
  const [input, output, artifactBaseUrl] = process.argv.slice(2);
  if (!input || !output || !artifactBaseUrl) {
    throw new Error('Usage: node scripts/render-channel-manifest.mjs <input> <output> <artifact-base-url>');
  }
  const source = await readFile(input, 'utf8');
  await writeFile(output, renderChannelManifest(source, artifactBaseUrl));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
