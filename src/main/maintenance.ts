import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDirectory } from './runtime-paths.js';

const DAY = 24 * 60 * 60 * 1000;

async function walkFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(path));
    else output.push(path);
  }
  return output;
}

async function removeOlderThan(paths: string[], cutoff: number): Promise<number> {
  let removed = 0;
  for (const path of paths) {
    try {
      const details = await stat(path);
      if (details.mtimeMs < cutoff) { await rm(path, { force: true }); removed += 1; }
    } catch { /* A concurrent cleanup or an unavailable file is harmless. */ }
  }
  return removed;
}

/** Runs only while the app is idle. It never touches platform session data or content records. */
async function cleanOldCliVersions(): Promise<number> {
  const root = join(dataDirectory(), 'bin', 'versions');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return 0; }
  const directories = [] as Array<{ path: string; mtimeMs: number }>;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { directories.push({ path: join(root, entry.name), mtimeMs: (await stat(join(root, entry.name))).mtimeMs }); } catch { /* ignore */ }
  }
  directories.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let removed = 0;
  for (const entry of directories.slice(2)) { await rm(entry.path, { recursive: true, force: true }); removed += 1; }
  return removed;
}

export async function runIdleMaintenance(now = Date.now()): Promise<{ evidence: number; temporary: number; updater: number; cliVersions: number }> {
  const root = dataDirectory();
  const evidenceRoots = [join(root, 'evidence')];
  try {
    for (const entry of await readdir(join(root, 'projects'), { withFileTypes: true })) {
      if (entry.isDirectory()) evidenceRoots.push(join(root, 'projects', entry.name, 'evidence'));
    }
  } catch { /* Projects are optional on a first launch. */ }
  const evidenceFiles = (await Promise.all(evidenceRoots.map((path) => walkFiles(path)))).flat();
  const evidence = await removeOlderThan(evidenceFiles, now - 90 * DAY);
  const temporaryRoots = ['projects', 'content', 'integrations', 'bin'].map((name) => join(root, name));
  const temporaryFiles = (await Promise.all(temporaryRoots.map((path) => walkFiles(path)))).flat().filter((path) => /\.tmp$|\.new$/.test(path));
  const temporary = await removeOlderThan(temporaryFiles, now - DAY);
  const updaterRoot = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'geo-publisher-desktop-updater')
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'geo-publisher-desktop-updater')
      : join(dataDirectory(), 'updater-cache');
  const updater = await removeOlderThan(await walkFiles(updaterRoot), now - 7 * DAY);
  return { evidence, temporary, updater, cliVersions: await cleanOldCliVersions() };
}
