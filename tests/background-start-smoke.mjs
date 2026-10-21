import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';

const isolatedUserDataDirectory = join(process.cwd(), 'release', 'test-background-user-data');
const isolatedControlEndpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\geo-background-${process.pid}`
  : join(isolatedUserDataDirectory, 'control.sock');
await mkdir(isolatedUserDataDirectory, { recursive: true });

const app = await electron.launch({
  args: ['.', '--background'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    GEO_DISABLE_OPEN_WORKBUDDY: '1',
    GEO_PUBLISHER_USER_DATA_DIR: isolatedUserDataDirectory,
    GEO_PUBLISHER_CONTROL_ENDPOINT: isolatedControlEndpoint,
  },
});

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('#version').filter({ hasText: /\d+\.\d+\.\d+/ }).waitFor({ state: 'attached' });
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })));
  if (!windows.length || windows.some((window) => window.visible || window.focused)) {
    throw new Error(`background launch showed a window: ${JSON.stringify(windows)}`);
  }
  const expectedAppName = 'Lingxi Workspace';
  assert.equal(await page.title(), expectedAppName);
  assert.equal(await page.locator('.app-brand strong').innerText(), expectedAppName);
  assert.equal(await app.evaluate(({ app }) => app.getName()), expectedAppName);
  if (process.platform === 'darwin') {
    const menu = await app.evaluate(({ Menu }) => {
      const application = Menu.getApplicationMenu()?.items[0];
      return { name: application?.label, labels: application?.submenu?.items.map(item => item.label) };
    });
    assert.equal(menu.name, expectedAppName);
    assert.ok(menu.labels.includes(`关于 ${expectedAppName}`));
    assert.ok(menu.labels.includes(`退出 ${expectedAppName}`));
  }
  await app.evaluate(({ app }) => app.emit('activate'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible()), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible()), false);
  if (process.platform === 'darwin') {
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('show-main-window');
      if (!item?.enabled) throw new Error('Missing enabled Window > Show Main Window action');
      item.click();
    });
  } else {
    await app.evaluate(({ app }) => app.emit('activate'));
  }
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible()), true);
  await page.locator('.app-nav').getByRole('button', { name: '设置', exact: true }).click();
  // Exercise the actual renderer with both store responses, including an update event.
  for (const message of ['此版本由 Mac App Store 管理更新，请前往 App Store 查看和安装更新。', '微软商店版由 Microsoft Store 管理更新']) {
    await app.evaluate(({ BrowserWindow }, message) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).webContents.send('geo:update-status-changed', {
        phase: 'disabled', currentVersion: '1.0.14', channel: 'stable', message,
        availableVersion: null, progress: null, checkedAt: null, canRestart: false,
      });
    }, message);
    await page.getByText(message, { exact: true }).waitFor();
    if (message.includes('Mac App Store')) assert.equal(await page.getByText(/Microsoft Store/).count(), 0);
  }
  // Check the MAS display name through the real sandboxed preload and renderer.
  // This previews branding on any OS; native macOS packaging/menu checks remain separate.
  const namedPagePromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    const preview = new BrowserWindow({
      width: 1360, height: 900, show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true, sandbox: true,
      },
    });
    await preview.loadURL(main.webContents.getURL());
  }, join(process.cwd(), 'dist', 'preload.cjs'));
  const namedPage = await namedPagePromise;
  namedPage.setDefaultTimeout(15_000);
  await namedPage.locator('.app-brand strong', { hasText: 'Lingxi Workspace' }).waitFor();
  assert.equal(await namedPage.title(), 'Lingxi Workspace');
  await namedPage.locator('.app-nav').getByRole('button', { name: '设置', exact: true }).click();
  await namedPage.evaluate(() => document.fonts.ready);
  assert.equal(await namedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('Background launch, close/reopen, store update text and MAS renderer branding verified.');
} finally {
  await app.close();
}
