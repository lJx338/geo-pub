import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { app, nativeImage, shell } from 'electron';
import packageJson from '../../package.json' with { type: 'json' };
import { APP_NAME } from '../shared/branding.js';

const { identityName, applicationId } = packageJson.build.appx;
const publisherId = '00tbjt2yye0b2';
const appUserModelId = `${identityName}_${publisherId}!${applicationId}`;
const activation = `shell:AppsFolder\\${appUserModelId}`;
const iconName = 'LingxiWorkspace.ico';
const legacyExecutable = /\\windowsapps\\78707cbf\.lingxiworkspace_\d+\.\d+\.\d+\.\d+_[^\\]+_00tbjt2yye0b2\\app\\lingxi workspace\.exe$/i;

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export async function installWindowsStoreShortcut(userData: string, logoPath: string): Promise<'created' | 'repaired' | 'skipped'> {
  const shortcutPath = join(app.getPath('desktop'), `${APP_NAME}.lnk`);
  const shortcutDirectory = join(userData, 'desktop-shortcut');
  const marker = join(shortcutDirectory, 'installed');
  const iconPath = join(shortcutDirectory, iconName);
  const existing = await statIfPresent(shortcutPath);
  if (existing && !existing.isFile()) return 'skipped';
  if (existing) {
    const link = shell.readShortcutLink(shortcutPath);
    if (!legacyExecutable.test(link.target)) {
      // Recover our icon after reinstall, and leave user-created links alone.
      if (link.args !== activation || link.description !== APP_NAME || basename(link.icon ?? '') !== iconName) return 'skipped';
      if (await statIfPresent(iconPath) && await statIfPresent(marker)) return 'skipped';
    }
  } else if (await statIfPresent(marker)) {
    return 'skipped'; // The user removed our shortcut.
  }

  const windowsDirectory = process.env.SystemRoot || process.env.WINDIR;
  if (!windowsDirectory || !isAbsolute(windowsDirectory)) throw new Error('Windows system directory is unavailable');

  await mkdir(shortcutDirectory, { recursive: true });
  if (!(await statIfPresent(iconPath))) {
    const image = nativeImage.createFromPath(logoPath);
    if (image.isEmpty()) throw new Error('Desktop shortcut logo could not be loaded');
    const logo = image.resize({ width: 64, height: 64 }).toPNG();
    const header = Buffer.from([0, 0, 1, 0, 1, 0, 64, 64, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
    header.writeUInt32LE(logo.length, 14);
    await writeFile(iconPath, Buffer.concat([header, logo]));
  }

  // Resolve AppData's physical path so Explorer can read the icon outside MSIX virtualization.
  if (!shell.writeShortcutLink(shortcutPath, existing ? 'replace' : 'create', {
    target: join(windowsDirectory, 'explorer.exe'),
    args: activation,
    description: APP_NAME,
    icon: await realpath(iconPath),
    iconIndex: 0,
  })) {
    throw new Error('Could not write the desktop shortcut');
  }
  await writeFile(marker, '');
  return existing ? 'repaired' : 'created';
}
