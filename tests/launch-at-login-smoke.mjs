import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

if (process.platform !== 'win32') {
  console.log('Windows startup settings smoke skipped on this platform.');
  process.exit(0);
}

const userDataDirectory = await mkdtemp(join(tmpdir(), 'geo-startup-settings-'));
const evidenceDirectory = join(process.cwd(), 'release', 'test-evidence');
await mkdir(evidenceDirectory, { recursive: true });
const application = await electron.launch({
  args: ['.', '--background'], cwd: process.cwd(),
  env: {
    ...process.env,
    GEO_DISABLE_OPEN_WORKBUDDY: '1',
    GEO_PUBLISHER_USER_DATA_DIR: userDataDirectory,
    GEO_PUBLISHER_CONTROL_ENDPOINT: `\\\\.\\pipe\\geo-startup-settings-${process.pid}`,
  },
});

try {
  const window = await application.firstWindow();
  window.setDefaultTimeout(15_000);
  await window.getByRole('button', { name: '设置', exact: true }).waitFor();
  await application.evaluate(({ ipcMain, shell }) => {
    ipcMain.removeHandler('geo:launch-at-login-status');
    ipcMain.handle('geo:launch-at-login-status', () => ({
      available: true, enabled: null, management: 'system',
      message: '在 Windows 启动设置中开启或关闭 Lingxi Workspace。',
    }));
    globalThis.startupSettingsUrls = [];
    shell.openExternal = async (url) => { globalThis.startupSettingsUrls.push(url); };
  });
  await window.getByRole('button', { name: '设置', exact: true }).click();
  const settingsButton = window.getByRole('button', { name: '打开 Windows 启动设置', exact: true });
  await settingsButton.waitFor();
  if (!(await settingsButton.isEnabled())) throw new Error('Store startup settings button is disabled');
  if (await window.getByRole('switch', { name: '开机启动', exact: true }).count()) {
    throw new Error('Store settings still show the unsupported login-item switch');
  }
  await settingsButton.evaluate((button) => button.scrollIntoView({ block: 'center' }));
  await window.screenshot({ path: join(evidenceDirectory, 'windows-store-startup-settings.png') });
  await settingsButton.click();
  await window.locator('#action-message', { hasText: '请在 Windows 启动设置中开启或关闭 Lingxi Workspace。' }).waitFor();
  const urls = await application.evaluate(() => globalThis.startupSettingsUrls);
  if (urls.length !== 1 || urls[0] !== 'ms-settings:startupapps') {
    throw new Error(`Startup settings opened an unexpected target: ${JSON.stringify(urls)}`);
  }
  console.log('Windows Store startup settings smoke passed.');
} finally {
  await application.close();
}
