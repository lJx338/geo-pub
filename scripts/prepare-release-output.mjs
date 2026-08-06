import fs from 'node:fs/promises';
import path from 'node:path';

const requested = process.argv[2] || 'release';
const outputDir = path.resolve(requested);
const releaseRoot = path.resolve('release');

// Build artifacts are disposable. Clearing the selected target prevents old
// versioned .app bundles from being mistaken for installed applications.
await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

// macOS Spotlight/Launchpad should never index build output. Keep this marker
// at the shared root so it survives electron-builder cleaning a target folder.
await fs.mkdir(releaseRoot, { recursive: true });
await fs.writeFile(path.join(releaseRoot, '.metadata_never_index'), 'GEO Publisher build output\n', 'utf8');

console.log(`Prepared release output: ${path.relative(process.cwd(), outputDir) || '.'}`);
