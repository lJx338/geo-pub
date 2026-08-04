import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { cliExecutablePath } from './runtime-paths.js';

function bundledCliName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'geo-publisher-darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'geo-publisher-darwin-amd64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'geo-publisher-windows-amd64.exe';
  return null;
}

export async function installBundledCli(version: string): Promise<string | null> {
  const sourceName = bundledCliName();
  if (!sourceName) return null;

  const source = app.isPackaged
    ? join(process.resourcesPath, 'cli', sourceName)
    : join(app.getAppPath(), 'dist', 'cli', sourceName);
  await stat(source);
  const destination = cliExecutablePath(process.platform === 'win32' ? version : undefined);
  const directory = join(destination, '..');
  const temporary = `${destination}.new`;
  await mkdir(directory, { recursive: true });
  if (process.platform === 'win32') {
    try {
      await stat(destination);
      return destination;
    } catch {
      // A new app version installs beside a running old CLI, avoiding Windows file locks.
    }
  }
  await rm(temporary, { force: true });
  await copyFile(source, temporary);
  if (process.platform !== 'win32') await chmod(temporary, 0o755);
  await rename(temporary, destination);
  await writeFile(join(directory, 'version.json'), JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2));
  return destination;
}
