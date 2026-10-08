import fs from 'node:fs/promises';
import path from 'node:path';

const requested = process.argv[2] || 'release';
const outputDir = path.resolve(requested);
const releaseRoot = path.resolve('release');

const relativeOutput = path.relative(releaseRoot, outputDir);
if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
  throw new Error('Release output must stay inside the project release directory');
}
// Store output is shared by Windows and macOS. Rebuilding Windows must retain
// signed Mac packages downloaded into this folder and local MAS build output.
if (outputDir === path.join(releaseRoot, 'store')) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.name.endsWith('.pkg') || entry.name.startsWith('mas-')) continue;
    await fs.rm(path.join(outputDir, entry.name), { recursive: true, force: true });
  }
} else {
  await fs.rm(outputDir, { recursive: true, force: true });
}
await fs.mkdir(outputDir, { recursive: true });

// macOS Spotlight/Launchpad should never index build output. Keep this marker
// at the shared root so it survives electron-builder cleaning a target folder.
await fs.mkdir(releaseRoot, { recursive: true });
await fs.writeFile(path.join(releaseRoot, '.metadata_never_index'), 'GEO Publisher build output\n', 'utf8');

console.log(`Prepared release output: ${path.relative(process.cwd(), outputDir) || '.'}`);
