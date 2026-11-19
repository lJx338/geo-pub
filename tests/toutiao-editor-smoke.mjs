import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

// Real Chromium navigation and input events, with all HTTPS served locally
// and a separate profile. No real account or publishing endpoint is used.
const directory = await mkdtemp(join(tmpdir(), 'geo-toutiao-editor-'));
const origin = 'https://mp.toutiao.com';
const editor = '/profile_v4/graphic/publish';
const html = body => `<!doctype html><html><head><meta charset="utf-8"><style>
  textarea,.ProseMirror { display:block; width:600px; min-height:80px; }
  button,a { display:inline-block; padding:16px; }
  </style></head><body>${body}</body></html>`;
const fields = (title = '', body = '') => `<textarea placeholder="请输入文章标题">${title}</textarea>
  <div class="ProseMirror" contenteditable="true">${body}</div>`;
const works = html('<p>共26条内容</p><p>当前只加载了10条</p><a href="/profile_v4/manage/draft">草稿箱(30)</a>');
let app;
let passed = 0;
try {
  const bundle = join(directory, 'adapter.cjs');
  await build({ entryPoints: ['src/main/toutiao-adapter.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const entry = join(directory, 'main.cjs');
  await writeFile(entry, `const { app, BrowserWindow, session } = require('electron');
    global.adapter = require(${JSON.stringify(bundle)});
    global.pages = {}; global.requests = [];
    app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(async () => {
      await session.defaultSession.protocol.handle('https', request => {
        const url = new URL(request.url); const key = url.pathname + url.search;
        global.requests.push(url.href);
        return new Response(global.pages[key] || '<html><body>Unknown fixture</body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      });
      const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
      await window.loadURL('https://mp.toutiao.com/start');
    });`);
  app = await electron.launch({ args: [entry], executablePath: resolve('node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron') });
  const page = await app.firstWindow();
  const setup = async (start, editorHtml = html(fields()), startHtml = works) => {
    const url = new URL(start);
    await app.evaluate((_, pages) => { global.pages = pages; global.requests = []; }, {
      [`${url.pathname}${url.search}`]: startHtml,
      [editor]: editorHtml,
    });
    await page.goto(start);
    await page.waitForLoadState('load');
  };
  const run = async (timeout = 3000) => app.evaluate(async ({ BrowserWindow }, timeout) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const mouseEvents = [];
    const types = { mouseMove: 'mouseMoved', mouseDown: 'mousePressed', mouseUp: 'mouseReleased' };
    let attached = false;
    // Deliver real, hit-tested Chromium input without relying on OS window focus.
    const testContents = {
      getURL: () => contents.getURL(),
      loadURL: url => contents.loadURL(url),
      sendInputEvent: event => { mouseEvents.push(event); },
      async executeJavaScript(script) {
        for (const { type, x, y, button, clickCount } of mouseEvents.splice(0)) {
          if (!contents.debugger.isAttached()) {
            contents.debugger.attach('1.3');
            attached = true;
          }
          await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: types[type], x, y, button, clickCount });
        }
        return contents.executeJavaScript(script);
      },
    };
    try {
      await global.adapter.ensureToutiaoEditor(testContents, timeout);
      return { status: 'ready' };
    } catch (error) { return { status: 'stopped', message: error.message }; }
    finally { if (attached && contents.debugger.isAttached()) contents.debugger.detach(); }
  }, timeout);
  const requests = () => app.evaluate(() => global.requests);
  const check = name => { passed++; console.log(`PASS ${name}`); };

  for (const start of [
    `${origin}/profile_v4/manage/content/all`,
    `${origin}/profile_v4/graphic/articles`,
    `${origin}/profile_v4/manage/draft`,
    `${origin}/profile_v4/index`,
    `${origin}/profile_v4/graphic/publish-history`,
    'https://example.com/other',
  ]) {
    await setup(start);
    assert.equal((await run()).status, 'ready');
    await page.waitForURL(`${origin}${editor}`);
    assert.deepEqual(await requests(), [start, `${origin}${editor}`]);
    check(`non-editor goes directly to writing page: ${new URL(start).pathname}`);
  }

  for (const suffix of ['', '?article_id=123', '/?article_id=123#editor']) {
    const start = `${origin}${editor}${suffix}`;
    const content = html(fields('保留标题', '保留正文'));
    await setup(start, content, content);
    assert.equal((await run()).status, 'ready');
    assert.deepEqual(await requests(), [start]);
    assert.equal(await page.locator('textarea').inputValue(), '保留标题');
    assert.equal(await page.locator('.ProseMirror').innerText(), '保留正文');
    check(`existing editor is preserved including draft query: ${suffix || 'plain'}`);
  }

  for (const label of ['继续编辑', '编辑草稿']) {
    const prompt = html(`${fields()}<button id="resume">${label}</button><script>
      window.resumeClicks = 0;
      document.querySelector('#resume').onclick = event => {
        if (!event.isTrusted) return;
        window.resumeClicks++;
        document.querySelector('textarea').value = '已恢复的草稿';
        document.querySelector('.ProseMirror').textContent = '已恢复的正文';
        document.querySelector('#resume').remove();
      };
    </script>`);
    const existingDraft = `${origin}${editor}?article_id=${label === '继续编辑' ? '100' : '200'}`;
    for (const start of [`${origin}/profile_v4/graphic/articles`, existingDraft]) {
      await setup(start, prompt, start === existingDraft ? prompt : works);
      if (start === existingDraft) await page.locator('#resume').waitFor();
      const result = await run();
      assert.equal(result.status, 'ready', result.message);
      await page.locator('#resume').waitFor({ state: 'detached', timeout: 3000 });
      assert.equal(await page.evaluate(() => window.resumeClicks), 1);
      assert.equal(await page.locator('textarea').inputValue(), '已恢复的草稿');
      assert.equal(await page.locator('.ProseMirror').innerText(), '已恢复的正文');
      assert.ok(!(await requests()).some(url => url.includes('/manage/draft')));
      check(`${label} still uses original recovery from ${new URL(start).pathname}`);
    }
  }

  await setup(`${origin}/profile_v4/graphic/articles`, html(`<p>加载中</p><script>
    setTimeout(() => { document.body.innerHTML = ${JSON.stringify(fields())}; }, 150);
  </script>`));
  assert.equal((await run()).status, 'ready');
  check('waits for a delayed editor after direct navigation');

  await setup(`${origin}/profile_v4/graphic/articles`, html('<p>编辑器加载失败</p>'));
  const failed = await run(200);
  assert.equal(failed.status, 'stopped');
  assert.match(failed.message, /TOUTIAO_EDITOR_NOT_READY/);
  assert.doesNotMatch(failed.message, /验证码|TOUTIAO_RECOVERY_UNCERTAIN/);
  assert.deepEqual(await requests(), [`${origin}/profile_v4/graphic/articles`, `${origin}${editor}`]);
  check('missing editor times out without scanning lists or inventing a captcha');

  const coverPath = join(directory, 'cover.png');
  await writeFile(coverPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  const originalBody = '<h2>印刷 logo</h2><ul><li>每批检查</li><li>末段保留</li></ul>';
  const fill = () => app.evaluate(async ({ BrowserWindow }, args) => {
    const original = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => original(fn, Math.min(ms, 25), ...rest);
    try {
      return await global.adapter.fillToutiaoDraft(BrowserWindow.getAllWindows()[0].webContents, '正文兼容测试', args.body, args.coverPath);
    } catch (error) { return { error: error.message, diagnostic: error.details?.toutiaoContent }; }
    finally { global.setTimeout = original; }
  }, { body: originalBody, coverPath });

  for (const { pasteSupported, corruptAfterSave } of [
    { pasteSupported: true, corruptAfterSave: false },
    { pasteSupported: false, corruptAfterSave: false },
    { pasteSupported: false, corruptAfterSave: true },
  ]) {
    await setup(`${origin}/profile_v4/graphic/articles`, html(`
      <textarea style="display:none" placeholder="旧标题"></textarea>
      ${fields()}
      <label><input type="checkbox" ${corruptAfterSave ? '' : 'checked'}>引用AI</label>
      <section>展示封面<label>单图</label><label>无封面</label><button>编辑</button><button>替换</button></section>
      <p>草稿已保存</p><button>预览并发布</button>
      <script>
        const body = document.querySelector('.ProseMirror');
        body.style.textTransform = 'uppercase';
        window.pastes = 0;
        let corrupt = !${corruptAfterSave};
        const truncate = () => { body.innerHTML = '<h2>印刷 logo</h2><ul><li>每批检查</li></ul>'; };
        body.addEventListener('input', () => { if (corrupt) truncate(); });
        if (${corruptAfterSave}) document.querySelector('input[type="checkbox"]').addEventListener('change', () => {
          corrupt = true;
          truncate();
        });
        body.addEventListener('paste', event => {
          window.pastes++;
          if (!${pasteSupported}) return;
          event.preventDefault();
          body.innerHTML = event.clipboardData.getData('text/html') + '<span class="ProseMirror-widget">编辑器工具</span>';
        });
      </script>`));
    const result = await fill();
    assert.equal(await page.evaluate(() => window.pastes), 1);
    if (pasteSupported) {
      assert.equal(result.bodyFilled, true, JSON.stringify(result));
      assert.equal(result.formatVerification.preserved, true);
      assert.equal(await page.locator('.ProseMirror li').count(), 2);
      check('rich paste recovers editor content when normal insertion loses a list item');
    } else {
      const code = corruptAfterSave ? 'TOUTIAO_CONTENT_NOT_STABLE' : 'TOUTIAO_CONTENT_FILL_FAILED';
      assert.match(result.error, new RegExp(`^${code}:.*expectedLength=14, actualLength=10, mismatchAt=11, difference=missing_text$`));
      assert.doesNotMatch(result.error, /印刷|每批|末段/);
      assert.equal(result.diagnostic.stage, corruptAfterSave ? 'after_save_check' : 'initial_fill');
      assert.deepEqual(result.diagnostic.checks.map(check => check.method), [corruptAfterSave ? 'read' : 'insert', 'paste', 'insert']);
      assert.ok(result.diagnostic.checks.every(check => check.writePath !== 'editor_paste'
        && check.difference === 'missing_text' && check.expectedSpanLength === 4 && check.actualSpanLength === 0));
      assert.doesNotMatch(JSON.stringify(result.diagnostic), /印刷|每批|末段/);
      check(`persistent truncation records the ${result.diagnostic.stage} stage, write attempts, and missing range`);
    }
  }

  console.log(`Toutiao editor smoke passed: ${passed} scenarios.`);
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
