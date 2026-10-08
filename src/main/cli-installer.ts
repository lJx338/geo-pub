import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { cliExecutablePath, isMacAppStoreRuntime } from './runtime-paths.js';

function bundledCliName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'geo-publisher-darwin-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'geo-publisher-windows-amd64.exe';
  return null;
}

export function bundledCliPath(): string | null {
  const name = bundledCliName();
  if (!name) return null;
  return app.isPackaged ? join(process.resourcesPath, 'cli', name) : join(app.getAppPath(), 'dist', 'cli', name);
}

export async function installBundledCli(version: string): Promise<string | null> {
  const sourceName = bundledCliName();
  if (!sourceName) return null;

  const source = app.isPackaged
    ? join(process.resourcesPath, 'cli', sourceName)
    : join(app.getAppPath(), 'dist', 'cli', sourceName);
  await stat(source);
  // MAS helpers must stay in the signed bundle and be launched by their sandboxed parent.
  // WorkBuddy uses this text launcher to send requests to that parent instead.
  if (isMacAppStoreRuntime()) {
    const launcher = join(process.resourcesPath, 'integrations', 'mas-cli', 'geo-publisher');
    await stat(launcher);
    return launcher;
  }
  const destination = cliExecutablePath(process.platform === 'win32' ? version : undefined);
  const directory = join(destination, '..');
  const temporary = `${destination}.new`;
  await mkdir(directory, { recursive: true });
  // Packaged Windows releases keep a versioned CLI beside the running app so
  // an older CLI can finish while a new release is installed. In an unpackaged
  // source run, however, the version stays the same while the developer
  // rebuilds the CLI; reusing the existing file would make WorkBuddy continue
  // calling the old `start` implementation.
  if (process.platform === 'win32' && app.isPackaged) {
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
