import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

// Exercise real Chromium hit testing, visibility, navigation and trusted input
// in an isolated profile. All HTTPS requests are intercepted locally.
const directory = await mkdtemp(join(tmpdir(), 'geo-toutiao-publish-'));
const title = '头条发布阶段测试';
const editorUrl = 'https://mp.toutiao.com/profile_v4/graphic/publish';
let app;
let passed = 0;
try {
  const bundle = join(directory, 'adapter.cjs');
  await build({ entryPoints: ['src/main/publish-adapter.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const entry = join(directory, 'main.cjs');
  await writeFile(entry, `const { app, BrowserWindow, session } = require('electron');
    global.adapter = require(${JSON.stringify(bundle)});
    global.requests = [];
    app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(async () => {
      await session.defaultSession.protocol.handle('https', request => {
        global.requests.push(request.url);
        return new Response('<!doctype html><html><body>Local fixture</body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      });
      const window = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
      await window.loadURL(${JSON.stringify(editorUrl)});
    });`);
  app = await electron.launch({ args: [entry], executablePath: resolve('node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron') });
  const page = await app.firstWindow();
  const setup = async (options = {}) => {
    await page.goto(editorUrl);
    await app.evaluate(() => { global.requests = []; });
    await page.setContent(`<!doctype html><html><head><style>
      body { margin:0; font:16px sans-serif; } button, .custom-control { padding:12px 20px; }
      .custom-control { display:inline-block; cursor:pointer; border:1px solid #999; }
      #article { height:1400px; }
      #primary { position:fixed; bottom:10px; right:10px; }
      #ad { position:fixed; inset:0; z-index:30; background:#0008; display:none; align-items:center; justify-content:center; }
      .byte-modal, .byte-popup { padding:30px; background:white; }
      #preview { position:fixed; inset:0; z-index:20; background:#ddd; display:none; }
      #phone { margin:30px; padding:20px; background:white; }
      #footer { position:absolute; bottom:0; right:0; background:white; padding:10px; }
      #cover { display:none; position:fixed; inset:0; z-index:50; background:#fff; }
    </style></head><body>
      <div id="article" contenteditable="true">正文提到“不投放广告”，不会产生广告收益；屏幕尺寸和手机预览。</div>
      <button id="primary">预览并发布</button>
      <div id="ad"><div class="byte-modal" role="dialog"><h2>提示</h2>
        <p id="adText">该文章选择了“不投放广告”，将不会产生广告收益。</p>
        <button id="cancel">取消</button><button id="adConfirm">确定</button>
      </div></div>
      <div id="preview"><div id="phone"><h2>${title}</h2><p>文章预览正文</p></div>
        <div id="labels"><span>屏幕尺寸</span><button>5.8寸</button><p>手机预览</p></div>
        <div id="footer"><button id="back">返回编辑</button><button id="confirm">确认发布</button></div>
      </div><div id="cover">遮挡层</div>
      <script>
        const options = ${JSON.stringify(options)};
        window.steps = []; window.adClicks = 0; window.confirmClicks = 0;
        window.trusted = []; window.primaryClicks = 0; window.unrelatedClicks = 0;
        const ad = document.querySelector('#ad');
        const preview = document.querySelector('#preview');
        if (options.nestedAd) {
          const prefix = options.nestedAd;
          const panel = document.querySelector('.byte-modal');
          ad.className = prefix + '-modal-wrapper';
          panel.className = prefix + '-modal';
          panel.style.cssText = 'padding:30px;background:white';
          const header = document.createElement('div');
          header.className = prefix + '-modal-header';
          header.append(panel.querySelector('h2'));
          const content = document.createElement('div');
          content.className = prefix + '-modal-content';
          content.append(document.querySelector('#adText'));
          const footer = document.createElement('div');
          footer.className = prefix + '-modal-footer';
          footer.append(document.querySelector('#cancel'), document.querySelector('#adConfirm'));
          panel.append(header, content, footer);
          if (options.noDialogRole) panel.removeAttribute('role');
          if (options.unrelatedAdButton) {
            const other = document.createElement('div');
            other.setAttribute('role', 'dialog');
            other.innerHTML = '<button>确定</button>';
            other.querySelector('button').onclick = () => { window.unrelatedClicks++; };
            ad.append(other);
          }
        }
        const showPreview = () => {
          if (options.noPreview) return;
          preview.style.display = 'block';
          if (options.transparent) preview.style.opacity = '0';
          if (options.hiddenAncestor) preview.style.visibility = 'hidden';
          if (options.noLabels) document.querySelector('#labels').remove();
          if (options.covered) document.querySelector('#cover').style.display = 'block';
          if (options.disabled) document.querySelector('#confirm').disabled = true;
          if (options.duplicate) document.querySelector('#footer').insertAdjacentHTML('beforeend', '<button>确认发布</button>');
          window.steps.push('preview');
        };
        if (options.earlyButton) {
          preview.style.display = 'block'; preview.style.opacity = '0';
        }
        if (options.missingAdButton) document.querySelector('#adConfirm').remove();
        if (options.missingAdControls) {
          document.querySelector('#adConfirm').remove();
          document.querySelector('#cancel').remove();
        }
        if (options.disabledAdButton) document.querySelector('#adConfirm').disabled = true;
        if (options.unmarkedAd) {
          const panel = document.querySelector('.byte-modal');
          panel.className = 'byte-popup';
          panel.removeAttribute('role');
        }
        if (options.absoluteAd) ad.style.position = 'absolute';
        if (options.ariaHiddenAd) ad.setAttribute('aria-hidden', 'true');
        for (const id of [
          ...(options.customAdButtons ? ['adConfirm', 'cancel'] : []),
          ...(options.customPreviewButtons ? ['back', 'confirm'] : []),
        ]) {
          const original = document.getElementById(id);
          const custom = document.createElement('div');
          custom.id = id; custom.className = 'custom-control';
          const label = document.createElement('span');
          label.textContent = original.textContent.split('').join(' ');
          custom.append(label); original.replaceWith(custom);
        }
        if (options.duplicateAdButton) document.querySelector('#cancel').insertAdjacentHTML('afterend', '<button>确定</button>');
        if (options.splitAdText) document.querySelector('#adText').innerHTML = '该文章选择了“<span>不投放广告</span>”，将不会产生<span>广告收益</span>。';
        if (options.inlineNotice) document.body.insertAdjacentHTML('beforeend', '<section>不投放广告，不会产生广告收益。<button>取消</button><button>确定</button></section>');
        if (options.quoteVariant) document.querySelector('#adText').textContent = '该文章选择了「不投放广告」，将不会产生广告收益。';
        const showAd = () => {
          ad.style.display = 'flex'; window.steps.push('ad');
          if (options.coveredAd) document.querySelector('#cover').style.display = 'block';
          if (options.adFooterDelay) {
            const footer = document.querySelector('.' + options.nestedAd + '-modal-footer');
            footer.style.display = 'none';
            setTimeout(() => { footer.style.display = 'block'; }, options.adFooterDelay);
          }
          if (options.adButtonDelay) {
            document.querySelector('#adConfirm').disabled = true;
            setTimeout(() => { document.querySelector('#adConfirm').disabled = false; }, options.adButtonDelay);
          }
          if (options.adCoverDelay) {
            document.querySelector('#cover').style.display = 'block';
            setTimeout(() => { document.querySelector('#cover').style.display = 'none'; }, options.adCoverDelay);
          }
          if (options.inertAdDelay) {
            ad.inert = true;
            setTimeout(() => { ad.inert = false; }, options.inertAdDelay);
          }
        };
        document.querySelector('#primary').onclick = () => {
          window.primaryClicks++;
          if (options.lateAd) { showPreview(); setTimeout(showAd, 50); }
          else if (options.directPreview) showPreview();
          else if (options.adDelay) setTimeout(showAd, options.adDelay);
          else showAd();
        };
        document.querySelector('#adConfirm')?.addEventListener('click', event => {
          window.trusted.push(event.isTrusted);
          if (!event.isTrusted) return;
          window.adClicks++; window.steps.push('ad-click');
          if (options.changedAdText) { document.querySelector('#adText').textContent = '正在处理，请稍候'; return; }
          if (options.stuckAd) return;
          const closeAd = () => {
            ad.style.display = 'none'; window.steps.push('ad-closed');
            preview.style.opacity = '1';
            setTimeout(showPreview, options.previewDelay || 0);
          };
          if (options.adCloseDelay) {
            document.querySelector('#adText').textContent = '正在处理，请稍候';
            setTimeout(closeAd, options.adCloseDelay);
          } else closeAd();
        });
        document.querySelector('#confirm').onclick = event => {
          window.trusted.push(event.isTrusted);
          if (!event.isTrusted) return;
          window.confirmClicks++; window.steps.push('confirm');
          if (options.reopenAd) { ad.style.display = 'flex'; return; }
          if (options.stuckPreview) return;
          history.replaceState({}, '', '/profile_v4/graphic/articles');
          document.body.innerHTML = '<h1>作品管理</h1><article>${title} 审核中</article>';
        };
      </script></body></html>`);
  };
  const run = () => app.evaluate(async ({ BrowserWindow }, title) => {
    const original = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => original(fn, Math.min(ms, 20), ...args);
    try { return await global.adapter.publishFilledDraft(BrowserWindow.getAllWindows()[0].webContents, 'toutiao', title); }
    finally { global.setTimeout = original; }
  }, title);
  const counts = () => page.evaluate(() => ({ ad: window.adClicks, confirmation: window.confirmClicks, unrelated: window.unrelatedClicks, steps: window.steps, trusted: window.trusted }));
  const noReconcileNavigation = async () => assert.deepEqual(await app.evaluate(() => global.requests), []);
  const check = name => { passed++; console.log(`PASS ${name}`); };

  // The real popup separates its message and footer into siblings whose
  // class names all match the broad modal selector. A wrapper may also host
  // unrelated dialogs, so selecting the outermost match is not sufficient.
  for (const options of [
    { nestedAd: 'byte' },
    { nestedAd: 'arco', noDialogRole: true },
    { nestedAd: 'byte', noDialogRole: true, unrelatedAdButton: true },
    { nestedAd: 'byte', customAdButtons: true, splitAdText: true },
    { nestedAd: 'byte', adCloseDelay: 260 },
    { nestedAd: 'custom', noDialogRole: true, unrelatedAdButton: true },
    { nestedAd: 'custom', noDialogRole: true, adFooterDelay: 260 },
  ]) {
    await setup(options);
    const result = await run();
    assert.equal(result.status, 'success', JSON.stringify({ options, result }));
    const observed = await counts();
    assert.equal(observed.ad, 1);
    assert.equal(observed.confirmation, 1);
    assert.equal(observed.unrelated, 0);
    assert.deepEqual(observed.steps, ['ad', 'ad-click', 'ad-closed', 'preview', 'confirm']);
    assert.deepEqual(observed.trusted, [true, true]);
    assert.ok(result.toutiaoChecks.some(item => item.phase === 'ad' && item.clicked && item.adDialogCount === 1));
    if (options.adFooterDelay) {
      assert.ok(result.toutiaoChecks.some(item => item.reason === 'ad_button_missing'));
    }
    check(`nested ad popup confirms before preview: ${JSON.stringify(options)}`);
  }

  for (const [options, reason] of [
    [{ missingAdButton: true }, 'ad_button_missing'],
    [{ missingAdControls: true }, 'ad_button_missing'],
    [{ duplicateAdButton: true }, 'ad_button_ambiguous'],
    [{ disabledAdButton: true }, 'ad_button_unavailable'],
    [{ coveredAd: true }, 'ad_button_unavailable'],
  ]) {
    await setup({ nestedAd: 'byte', noDialogRole: true, unrelatedAdButton: true, ...options });
    const result = await run();
    assert.equal(result.status, 'action_required', JSON.stringify({ options, result }));
    assert.equal(result.stage, 'toutiao_ad_confirm');
    assert.ok(result.toutiaoChecks.every(item => item.phase === 'inspect' && item.reason === reason));
    const observed = await counts();
    assert.equal(observed.ad, 0);
    assert.equal(observed.confirmation, 0);
    assert.equal(observed.unrelated, 0);
    await noReconcileNavigation();
    assert.equal(await page.locator('#ad').isVisible(), true);
    check(`nested ad popup safely stops: ${JSON.stringify(options)}`);
  }

  for (const zoom of [0.8, 1, 1.25, 1.5]) {
    await setup();
    await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom);
    await page.evaluate(() => scrollTo(0, 500));
    const result = await run();
    assert.equal(result.status, 'success', JSON.stringify({ zoom, result, counts: await counts() }));
    assert.equal(result.adDialogClosed, true);
    assert.equal(result.previewObserved, true);
    assert.equal(result.confirmationClicked, true);
    assert.deepEqual((await counts()).steps, ['ad', 'ad-click', 'ad-closed', 'preview', 'confirm']);
    assert.deepEqual((await counts()).trusted, [true, true]);
    check(`native ad and final clicks follow verified preview at zoom ${zoom}`);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));

  for (const options of [
    { quoteVariant: true }, { directPreview: true }, { previewDelay: 180 }, { earlyButton: true },
    { unmarkedAd: true }, { unmarkedAd: true, splitAdText: true },
    { unmarkedAd: true, directPreview: true },
    { directPreview: true, inlineNotice: true },
    { unmarkedAd: true, absoluteAd: true },
    { unmarkedAd: true, customAdButtons: true, customPreviewButtons: true },
    { directPreview: true, customPreviewButtons: true },
    { unmarkedAd: true, adDelay: 180 },
    { unmarkedAd: true, adButtonDelay: 260 },
    { unmarkedAd: true, adCloseDelay: 260 },
    { unmarkedAd: true, adCoverDelay: 260 },
    { unmarkedAd: true, lateAd: true },
    { unmarkedAd: true, ariaHiddenAd: true },
    { unmarkedAd: true, inertAdDelay: 260 },
  ]) {
    await setup(options);
    const result = await run();
    assert.equal(result.status, 'success', JSON.stringify({ options, result }));
    assert.equal((await counts()).confirmation, 1);
    assert.equal((await counts()).ad, options.directPreview ? 0 : 1);
    assert.equal(result.adDialogObserved, !options.directPreview);
    assert.equal(result.adDialogClosed, true);
    assert.ok(result.toutiaoChecks.some(check => check.phase === 'confirmation' && check.clicked));
    if (options.unmarkedAd && !options.directPreview) assert.ok(result.toutiaoChecks.some(check => check.adDetection === 'semantic'));
    if (!options.directPreview) assert.ok((await counts()).steps.indexOf('confirm') > (await counts()).steps.indexOf('ad-closed'));
    assert.ok((await counts()).steps.indexOf('confirm') > (await counts()).steps.indexOf('preview'));
    check(`preview gating succeeds: ${JSON.stringify(options)}`);
  }

  for (const options of [
    { stuckAd: true }, { missingAdButton: true }, { changedAdText: true },
    { unmarkedAd: true, stuckAd: true }, { unmarkedAd: true, changedAdText: true },
    { unmarkedAd: true, missingAdButton: true }, { unmarkedAd: true, duplicateAdButton: true },
  ]) {
    await setup(options);
    const result = await run();
    assert.equal(result.status, 'action_required');
    assert.equal(result.stage, 'toutiao_ad_confirm');
    assert.equal(result.adDialogClosed, false);
    assert.equal(result.confirmationClicked, false);
    assert.equal((await counts()).confirmation, 0);
    assert.equal((await counts()).ad, options.missingAdButton || options.duplicateAdButton ? 0 : 1);
    await noReconcileNavigation();
    assert.equal(await page.locator('#ad').isVisible(), true);
    check(`unclosed ad dialog stops in place: ${JSON.stringify(options)}`);
  }

  for (const options of [
    { noPreview: true }, { directPreview: true, noLabels: true },
    { directPreview: true, transparent: true }, { directPreview: true, hiddenAncestor: true },
    { covered: true }, { disabled: true }, { duplicate: true },
  ]) {
    await setup(options);
    const result = await run();
    assert.equal(result.status, 'action_required', JSON.stringify({ options, result }));
    assert.equal(result.stage, 'toutiao_preview');
    assert.equal(result.confirmationClicked, false);
    assert.equal((await counts()).confirmation, 0);
    if (options.noPreview || options.noLabels) assert.equal(result.adDialogClosed, false);
    await noReconcileNavigation();
    check(`incomplete or inaccessible preview cannot submit: ${JSON.stringify(options)}`);
  }

  for (const options of [{ stuckPreview: true }, { reopenAd: true }]) {
    await setup(options);
    const result = await run();
    assert.equal(result.status, 'result_uncertain');
    assert.equal(result.confirmationClicked, true);
    assert.equal((await counts()).confirmation, 1);
    await noReconcileNavigation();
    check(`post-submit uncertainty preserves the page without another click: ${JSON.stringify(options)}`);
  }

  console.log(`Toutiao publish smoke passed: ${passed} scenarios.`);
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
