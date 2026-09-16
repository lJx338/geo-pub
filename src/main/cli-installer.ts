import { chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { replaceFile } from './file-replace.js';
import { cliLauncherPath, coreCliPath } from './runtime-paths.js';

export interface InstalledCli {
  launcherPath: string;
  coreCliPath: string;
}

function bundledCliNames(): { launcher: string; core: string } | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { launcher: 'geo-publisher-launcher-darwin-arm64', core: 'geo-publisher-core-darwin-arm64' };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { launcher: 'geo-publisher-launcher-windows-amd64.exe', core: 'geo-publisher-core-windows-amd64.exe' };
  }
  return null;
}

async function installBinary(source: string, destination: string, replaceExisting: boolean): Promise<void> {
  const temporary = `${destination}.new`;
  await mkdir(join(destination, '..'), { recursive: true });
  if (!replaceExisting) {
    try {
      await stat(destination);
      return;
    } catch {
      // The versioned Core CLI does not replace an existing executable.
    }
  }
  await rm(temporary, { force: true });
  await copyFile(source, temporary);
  if (process.platform !== 'win32') await chmod(temporary, 0o755);
  await replaceFile(temporary, destination);
}

async function installLauncher(source: string, destination: string): Promise<void> {
  try {
    await installBinary(source, destination, true);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
    // A WorkBuddy invocation can briefly lock the fixed Windows launcher.
    // The launcher contract is backwards compatible, so the old binary can
    // safely dispatch to the new Core CLI via the freshly written Discovery.
    await stat(destination);
  }
}

export async function installBundledCli(version: string): Promise<InstalledCli | null> {
  const names = bundledCliNames();
  if (!names) return null;

  const sourceRoot = app.isPackaged ? join(process.resourcesPath, 'cli') : join(app.getAppPath(), 'dist', 'cli');
  const launcherSource = join(sourceRoot, names.launcher);
  const coreSource = join(sourceRoot, names.core);
  await Promise.all([stat(launcherSource), stat(coreSource)]);

  const launcherPath = cliLauncherPath();
  const activeCorePath = coreCliPath(version);
  // Windows may lock a running launcher. The launcher protocol is deliberately
  // stable, so retaining the previous launcher is safe while its Core switches.
  await installLauncher(launcherSource, launcherPath);
  await installBinary(coreSource, activeCorePath, false);
  await writeFile(join(activeCorePath, '..', 'version.json'), JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2));
  return { launcherPath, coreCliPath: activeCorePath };
}
