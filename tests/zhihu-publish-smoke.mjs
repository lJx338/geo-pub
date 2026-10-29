import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

// All pages are local fixtures in an isolated Electron profile. No real
// platform requests, credentials or articles are used.
const directory = await mkdtemp(join(tmpdir(), 'geo-zhihu-publish-'));
let app;
try {
  const adapterPath = join(directory, 'adapter.cjs');
  await build({ entryPoints: ['src/main/publish-adapter.ts'], outfile: adapterPath, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const controlsPath = join(directory, 'controls.cjs');
  await build({ stdin: { contents: "export { clickZhihuPublishControl } from './src/main/zhihu-publish-controls.ts'; export { ensureZhihuEditor } from './src/main/zhihu-adapter.ts';", resolveDir: process.cwd(), loader: 'ts' }, outfile: controlsPath, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const entry = join(directory, 'main.cjs');
  await writeFile(entry, `const { app, BrowserWindow, session } = require('electron');
    global.fixtureAdapter = require(${JSON.stringify(adapterPath)});
    global.fixtureControls = require(${JSON.stringify(controlsPath)});
    app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(async () => {
      await session.defaultSession.protocol.handle('https', () => new Response('<!doctype html><html><body>Fixture</body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
      const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
      await window.loadURL('https://zhuanlan.zhihu.com/p/42/edit');
    });`);
  app = await electron.launch({ args: [entry], executablePath: resolve('node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron') });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const setup = async (onPrimary = '', extra = '', before = '') => {
    await page.goto('https://zhuanlan.zhihu.com/p/42/edit');
    await page.setContent(`<!doctype html><html><head><style>
      body { margin: 0; font: 16px sans-serif; } button { padding: 14px; }
      #editor { height: 1200px; } #footer { position: fixed; bottom: 0; left: 0; width: 100%; background: white; }
      #panel { position: fixed; top: 100px; left: 50px; padding: 30px; background: white; border: 1px solid; }
    </style></head><body><div id="editor" contenteditable="true">正文包含“确认发布”这几个字</div>
      ${extra}<footer id="footer">草稿 发布设置<button id="primary">发布</button></footer>
      <script>window.primaryCount = 0; window.confirmationCount = 0;
        ${before}
        document.querySelector('#primary').onclick = () => { window.primaryCount++; ${onPrimary} };
      </script></body></html>`);
  };
  const click = async (phase, id = 'fixture') => app.evaluate(async ({ BrowserWindow }, { controlsPath, phase, id }) => {
    const { clickZhihuPublishControl } = global.fixtureControls;
    return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(${clickZhihuPublishControl.toString()})(${JSON.stringify(id)}, ${JSON.stringify(phase)})`, true);
  }, { controlsPath, phase, id });
  const run = async () => app.evaluate(async ({ BrowserWindow }, adapterPath) => {
    const { publishFilledDraft } = global.fixtureAdapter;
    // Accelerate only main-process polling; renderer layout and click delivery
    // still use the real Chromium event loop.
    const original = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => original(fn, Math.min(ms, 5), ...args);
    try { return await publishFilledDraft(BrowserWindow.getAllWindows()[0].webContents, 'zhihu', '测试文章'); }
    finally { global.setTimeout = original; }
  }, adapterPath);
  const counts = () => page.evaluate(() => [window.primaryCount, window.confirmationCount]);

  for (const zoom of [0.8, 1, 1.25, 1.5]) {
    await setup("history.replaceState({}, '', '/p/42');");
    await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom);
    await page.evaluate(() => scrollTo(0, 700));
    assert.equal((await run()).status, 'success', `direct publish at zoom ${zoom}`);
    assert.deepEqual(await counts(), [1, 0]);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));

  // Both an ordinary panel (with form fields) and a modal can provide the
  // second step. Only the newly revealed confirmation gets activated.
  for (const panel of [
    '<div id="panel"><div>发布设置</div><label>创作声明<input value="AI 辅助创作"></label><button id="confirm">发布</button></div>',
    '<div id="panel" role="dialog"><p>确认发布这篇文章？</p><button id="confirm">确认发布</button></div>',
  ]) {
    await setup(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(panel)});
      document.querySelector('#confirm').onclick = () => { window.confirmationCount++; history.replaceState({}, '', '/p/42'); };`);
    const result = await run();
    assert.equal(result.status, 'success');
    assert.equal(result.confirmationClicked, true);
    assert.deepEqual(await counts(), [1, 1]);
  }

  await setup('', '<div style="position:fixed;inset:0;z-index:99;background:white">遮挡层</div>');
  assert.deepEqual(await click('primary'), { clicked: false, reason: 'covered' });
  assert.deepEqual(await counts(), [0, 0]);

  await setup('', '<button style="position:fixed;top:20px;left:10px">发布</button>');
  assert.deepEqual(await click('primary'), { clicked: false, reason: 'ambiguous' });
  assert.deepEqual(await counts(), [0, 0]);

  // Replacing the toolbar with a new DOM node must not turn the original
  // primary button into a second submission opportunity.
  await setup(`document.querySelector('#footer').outerHTML = '<footer id="footer">草稿 发布设置<button id="primary" class="rerendered">发布</button></footer>';
    document.querySelector('#primary').onclick = () => window.primaryCount++;`);
  assert.equal((await run()).status, 'result_uncertain');
  assert.deepEqual(await counts(), [1, 0]);

  await setup('', '<section id="panel"><h2>发布设置</h2><button id="confirm">确认发布</button></section>',
    "document.querySelector('#confirm').onclick = () => window.confirmationCount++;");
  assert.equal((await run()).status, 'result_uncertain');
  assert.deepEqual(await counts(), [1, 0], 'a pre-existing confirmation must not be mistaken for a new step');

  await setup(`document.body.insertAdjacentHTML('beforeend', '<section id="panel"><h2>发布设置</h2><button id="confirm">确认发布</button></section>');
    document.querySelector('#confirm').onclick = () => window.confirmationCount++;`);
  assert.equal((await run()).status, 'result_uncertain');
  assert.deepEqual(await counts(), [1, 1], 'an unchanged confirmation must not be clicked repeatedly');

  await setup("document.body.insertAdjacentHTML('beforeend', '<div role=alert>发布失败，请稍后再试</div>');");
  assert.equal((await run()).status, 'action_required');
  assert.deepEqual(await counts(), [1, 0]);

  await setup();
  assert.equal((await click('primary')).clicked, true);
  assert.equal((await click('primary')).reason, 'already_clicked');
  assert.deepEqual(await counts(), [1, 0]);
  // The live Zhihu page can open this notice after accepting editor text.
  // Readiness must acknowledge only that notice, then wait for stable fields.
  await page.goto('https://zhuanlan.zhihu.com/p/42/edit');
  await page.setContent(`<textarea placeholder="请输入标题">测试文章</textarea>
    <div class="public-DraftEditor-content" contenteditable="true" role="textbox">完整正文</div>
    <div class="Modal-wrapper"><div class="Modal-content">草稿加载中，请等待加载完成后再次修改。<button id="notice"> 确定 </button></div></div>
    <script>window.noticeClicks=0;document.querySelector('#notice').onclick=()=>{window.noticeClicks++;document.querySelector('.Modal-wrapper').remove();};</script>`);
  const ensureEditor = () => app.evaluate(async ({ BrowserWindow }) => {
    const original = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => original(fn, Math.min(ms, 5), ...args);
    try { await global.fixtureControls.ensureZhihuEditor(BrowserWindow.getAllWindows()[0].webContents, 1000); }
    finally { global.setTimeout = original; }
  });
  await ensureEditor();
  assert.equal(await page.evaluate(() => window.noticeClicks), 1);
  assert.equal(await page.locator('[contenteditable]').innerText(), '完整正文');
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog">安全验证<button onclick="window.noticeClicks++">确定</button></div>'));
  await assert.rejects(ensureEditor(), /ZHIHU_LOGIN_REQUIRED/);
  assert.equal(await page.evaluate(() => window.noticeClicks), 1, 'never dismiss verification prompts');

  console.log('Zhihu publish smoke passed: zoom/scroll, direct submit, panel/modal confirmation, obstruction, ambiguity, rerender, no duplicate submit, platform error.');
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
