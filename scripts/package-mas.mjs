import { build, Platform, Arch } from 'electron-builder';
import { masConfig } from './mas-config.mjs';

if (process.platform !== 'darwin') throw new Error('Run package:mas on a Mac or GitHub macOS runner. Windows cannot sign a Mac App Store package.');
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_INSTALLER_LINK', 'CSC_INSTALLER_KEY_PASSWORD']) {
  if (!process.env[name]) throw new Error(`Missing signing setting: ${name}`);
}
await build({ targets: Platform.MAC.createTarget('mas', Arch.arm64), config: masConfig(), publish: 'never' });
