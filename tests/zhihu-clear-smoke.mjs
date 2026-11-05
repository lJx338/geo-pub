import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

// Isolated local pages only: never connects to Zhihu or the user's profile.
const directory = await mkdtemp(join(tmpdir(), 'geo-zhihu-clear-'));
let app;
try {
  const adapter = join(directory, 'adapter.cjs');
  await build({ entryPoints: ['src/main/zhihu-adapter.ts'], outfile: adapter, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const entry = join(directory, 'main.cjs');
  await writeFile(entry, `const { app, BrowserWindow } = require('electron');
    global.clearEditor = require(${JSON.stringify(adapter)}).clearZhihuEditor;
    app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(() => new BrowserWindow({ width: 1000, height: 700, show: false,
      webPreferences: { backgroundThrottling: false } }).loadURL('about:blank'));`);
  app = await electron.launch({ args: [entry], executablePath: resolve('node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron') });
  const page = await app.firstWindow();
  const setup = async (mode = '') => {
    await page.setContent(`<style>
      body { margin: 0; } header { position: fixed; top: 0; height: 90px; background: white; z-index: 2; }
      #editor { margin: 100px 250px 200px 30px; } p { min-height: 50px; }
      aside { position: fixed; right: 0; top: 90px; width: 240px; }
      footer { position: fixed; bottom: 0; height: 50px; background: white; }
    </style><header>工具栏</header><div id="editor" class="public-DraftEditor-content" role="textbox" contenteditable="true">${Array.from({ length: 70 }, (_, i) => `<p>旧正文 ${i} 完整内容</p>`).join('')}</div><aside>创作助手</aside><footer>发布设置</footer>
    <script>
      window.deletes = 0; window.selects = 0;
      document.addEventListener('beforeinput', e => { if (e.inputType.startsWith('delete')) window.deletes++; });
      document.addEventListener('keyup', e => {
        if (e.code !== 'KeyA') return;
        window.selects++;
        const mode = ${JSON.stringify(mode)};
        if (mode === 'whole' || (mode === 'recover' && window.selects === 1)) {
          const range = document.createRange(); range.selectNodeContents(document.body);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        } else if (mode === 'partial') {
          const range = document.createRange(); range.selectNodeContents(document.querySelector('#editor p'));
          getSelection().removeAllRanges(); getSelection().addRange(range);
        } else if (mode === 'focus') document.querySelector('#editor').blur();
      });
    </script>`);
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  };
  const clear = () => app.evaluate(async ({ BrowserWindow }) => {
    try { await global.clearEditor(BrowserWindow.getAllWindows()[0].webContents); return 'ok'; }
    catch (error) { return error.message; }
  });
  for (const zoom of [0.8, 1, 1.5]) {
    await setup();
    await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom);
    assert.equal(await clear(), 'ok', `long scrolled body at zoom ${zoom}`);
    assert.equal((await page.locator('#editor').innerText()).trim(), '');
    assert.equal(await page.locator('aside').innerText(), '创作助手');
    assert.ok(await page.evaluate(() => window.deletes > 0));
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  for (const mode of ['whole', 'partial', 'focus']) {
    await setup(mode);
    const original = await page.locator('#editor').innerText();
    assert.match(await clear(), /ZHIHU_CLEAR_FAILED/, mode);
    assert.equal(await page.evaluate(() => window.deletes), 0, `${mode}: no destructive input`);
    assert.equal(await page.locator('#editor').innerText(), original);
    assert.equal(await page.evaluate(() => getSelection().rangeCount), 0);
  }
  await setup('recover');
  assert.equal(await clear(), 'ok', 'recover after one page-wide selection');
  assert.equal(await page.evaluate(() => window.selects), 2);
  await setup();
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0;z-index:100;background:white">遮挡层</div>'));
  assert.match(await clear(), /ZHIHU_CLEAR_FAILED/);
  assert.equal(await page.evaluate(() => window.deletes), 0);
  console.log('Zhihu clear smoke passed: long articles, zoom, page-wide/partial selection, focus loss, recovery, overlay.');
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
