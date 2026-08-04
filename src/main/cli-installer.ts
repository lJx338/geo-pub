import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { dataDirectory } from './runtime-paths.js';

function bundledCliName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'geo-publisher-darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'geo-publisher-darwin-amd64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'geo-publisher-windows-amd64.exe';
  return null;
}

export async function installBundledCli(version: string): Promise<string | null> {
  if (!app.isPackaged) return null;
  const sourceName = bundledCliName();
  if (!sourceName) return null;

  const source = join(process.resourcesPath, 'cli', sourceName);
  await stat(source);
  const directory = join(dataDirectory(), 'bin');
  const destination = join(directory, process.platform === 'win32' ? 'geo-publisher.exe' : 'geo-publisher');
  const temporary = `${destination}.new`;
  await mkdir(directory, { recursive: true });
  await rm(temporary, { force: true });
  await copyFile(source, temporary);
  if (process.platform !== 'win32') await chmod(temporary, 0o755);
  if (process.platform === 'win32') {
    const previous = `${destination}.old`;
    await rm(previous, { force: true });
    try {
      await rename(destination, previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temporary, destination);
    await rm(previous, { force: true }).catch(() => undefined);
  } else {
    await rename(temporary, destination);
  }
  await writeFile(join(directory, 'version.json'), JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2));
  return destination;
}
