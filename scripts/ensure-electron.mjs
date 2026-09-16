import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
const candidates = [
  process.env.ELECTRON_OVERRIDE_DIST_PATH,
  join(process.cwd(), 'node_modules', 'electron', 'dist'),
].filter(Boolean);

for (const directory of candidates) {
  try {
    await access(join(directory, executable));
    process.exit(0);
  } catch {
    // Try the next configured runtime.
  }
}

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => code === 0
    ? resolve()
    : reject(new Error(`Electron installation exited with code ${code}`)));
});
