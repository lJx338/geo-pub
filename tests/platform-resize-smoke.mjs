import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Exercise real native window events, with local pages and an isolated customer store.
const root = await mkdtemp(join(tmpdir(), 'geo-platform-resize-'));
const env = {
  ...process.env, GEO_PUBLISHER_USER_DATA_DIR: root, GEO_DISABLE_OPEN_WORKBUDDY: '1',
  GEO_PUBLISHER_CONTROL_ENDPOINT: 'tcp://127.0.0.1:0',
  GEO_PUBLISHER_TEST_PLATFORM_URL: pathToFileURL(join(process.cwd(), 'tests/fixtures/silent-platform.html')).href,
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env, timeout: 20_000 });
try {
  const page = await app.firstWindow({ timeout: 20_000 });
  await page.locator('.app-sidebar').waitFor();
  const main = await app.browserWindow(page);
  await page.evaluate(() => window.geoPublisher.createProject({ name: '窗口恢复测试客户' }));

  async function eventually(check) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try { await check(); return; } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(50);
      }
    }
  }

  async function assertLayout() {
    await eventually(async () => {
      const state = await main.evaluate(async (window) => {
        const view = window.contentView.children.find((child) => child.webContents);
        const [width, height] = window.getContentSize();
        const ui = await window.webContents.executeJavaScript(`({
          sidebar: document.querySelector('.app-sidebar').getBoundingClientRect().right,
          toolbar: document.querySelector('.platform-toolbar').getBoundingClientRect().bottom
        })`);
        const viewport = await view.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })');
        return { width, height, ui, viewport, bounds: view.getBounds(), visible: view.getVisible() };
      });
      const expected = {
        x: state.ui.sidebar, y: state.ui.toolbar,
        width: state.width - state.ui.sidebar, height: state.height - state.ui.toolbar,
      };
      assert.deepEqual(state.bounds, expected, 'platform must fill the area below the toolbar');
      assert.deepEqual(state.viewport, { width: expected.width, height: expected.height });
      assert.equal(state.visible, true);
    });
  }

  async function minimize() {
    const bounds = await main.evaluate((window) => {
      const bounds = window.contentView.children.find((child) => child.webContents).getBounds();
      window.minimize();
      return bounds;
    });
    await eventually(async () => assert.equal(await main.evaluate((window) => window.isMinimized()), true));
    return bounds;
  }

  const platforms = ['wechat', 'baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease', 'lieju'];
  for (const platform of platforms) {
    await main.evaluate((window) => window.minimize());
    await eventually(async () => assert.equal(await main.evaluate((window) => window.isMinimized()), true));
    await page.evaluate((platform) => window.geoPublisher.openPlatform(platform), platform);
    await page.locator('#platform-back').waitFor();
    await main.evaluate((window) => window.setSize(1360, 900));
    await assertLayout();

    // A late page load while minimized used to write 320x240 bounds. A normal
    // restore often emits no resize event, leaving that tiny view on screen.
    const boundsBeforeLoad = await minimize();
    await main.evaluate(async (window) => {
      const contents = window.contentView.children.find((child) => child.webContents).webContents;
      const loaded = new Promise((resolve) => contents.once('did-finish-load', resolve));
      contents.reload();
      await loaded;
    });
    assert.deepEqual(await main.evaluate((window) => window.contentView.children.find((child) => child.webContents).getBounds()), boundsBeforeLoad);
    await main.evaluate((window) => window.restore());
    await assertLayout();

    // Subsequent window operations must preserve the existing page and edits.
    const pageId = await main.evaluate(async (window) => {
      const contents = window.contentView.children.find((child) => child.webContents).webContents;
      await contents.executeJavaScript(`document.querySelector('input').value = '未保存的测试内容'; window.resizeTestMarker = 'same-page'`);
      return contents.id;
    });
    for (const size of [[920, 640], [1360, 900], [1050, 760]]) {
      await main.evaluate((window, size) => window.setSize(...size), size);
      await assertLayout();
    }
    await minimize();
    await main.evaluate((window) => window.restore());
    await assertLayout();
    await main.evaluate((window) => window.maximize());
    await eventually(async () => assert.equal(await main.evaluate((window) => window.isMaximized()), true));
    await assertLayout();
    const maximizedBounds = await minimize();
    assert.deepEqual(await main.evaluate((window) => window.contentView.children.find((child) => child.webContents).getBounds()), maximizedBounds);
    await main.evaluate((window) => window.restore());
    await assertLayout();
    await main.evaluate((window) => window.unmaximize());
    await assertLayout();
    await main.evaluate((window) => window.hide());
    await main.evaluate((window) => window.show());
    await assertLayout();
    const preserved = await main.evaluate(async (window) => {
      const contents = window.contentView.children.find((child) => child.webContents).webContents;
      return { id: contents.id, ...await contents.executeJavaScript('({ marker: window.resizeTestMarker, input: document.querySelector("input").value })') };
    });
    assert.deepEqual(preserved, { id: pageId, marker: 'same-page', input: '未保存的测试内容' });
    console.log(`${platform}: resize, minimize/restore, maximize/restore and hide/show passed; page preserved`);
  }
  await page.locator('#platform-back').click();
  await page.locator('#platform-back').waitFor({ state: 'detached' });
  assert.equal(await main.evaluate((window) => window.contentView.children.filter((child) => child.webContents).length), 0);
  console.log('All eight platforms passed; returning to the workspace removes the embedded view.');
} finally {
  await app.close();
}
