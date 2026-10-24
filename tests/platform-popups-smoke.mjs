import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { _electron as electron } from 'playwright';

const userDataDirectory = await mkdtemp(join(tmpdir(), 'geo-popup-smoke-'));
let platformOrigin;
let authOrigin;
const platformServer = createServer(async (request, response) => {
  if (request.url === '/slow-resource') return;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/post') {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.end(`<p id="post-result">${request.method}:${body}</p>`);
    return;
  }
  if (request.url === '/complete') {
    response.setHeader('Set-Cookie', 'platform_auth=popup-test; Path=/; SameSite=Lax');
    response.end('<p id="complete">授权完成</p>');
    return;
  }
  if (request.url === '/page') {
    response.end(`<a id="nested" target="_blank" href="${platformOrigin}/nested">继续授权</a>`);
    return;
  }
  if (request.url === '/nested') {
    response.end('<p id="nested-result">嵌套弹窗</p>');
    return;
  }
  response.end(`<!doctype html><html><body>
    <h1>平台注册页</h1>
    <button id="wechat">微信注册</button>
    <a id="newtab" target="_blank" href="${platformOrigin}/page">新窗口</a>
    <form action="${platformOrigin}/post" method="post" target="loginPost">
      <input name="code" value="test-value"><button id="post">提交授权</button>
    </form>
    <button id="start-loading">加载第三方资源</button>
    <p id="callback"></p>
    <script>
      document.querySelector('#wechat').onclick = () => {
        const popup = window.open('', 'wechatAuth');
        window.blankPopupCreated = Boolean(popup);
        setTimeout(() => { if (popup) popup.location = '${authOrigin}/authorize'; }, 50);
      };
      addEventListener('message', event => {
        if (event.origin === '${authOrigin}') document.querySelector('#callback').textContent = event.data;
      });
      document.querySelector('#start-loading').onclick = () => {
        const iframe = document.createElement('iframe');
        iframe.src = '/slow-resource'; document.body.append(iframe);
      };
    </script>
  </body></html>`);
});
const authServer = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><body>
    <button id="authorize">完成授权</button>
    <script>
      document.querySelector('#authorize').onclick = () => {
        window.opener.postMessage('authorized', '${platformOrigin}');
        location.href = '${platformOrigin}/complete';
      };
    </script>
  </body></html>`);
});
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
platformOrigin = await listen(platformServer);
authOrigin = await listen(authServer);
let app;
try {
  app = await electron.launch({
    args: ['.'], cwd: process.cwd(), timeout: 30_000,
    env: {
      ...process.env,
      GEO_DISABLE_OPEN_WORKBUDDY: '1',
      GEO_PUBLISHER_USER_DATA_DIR: userDataDirectory,
      GEO_PUBLISHER_CONTROL_ENDPOINT: process.platform === 'win32'
        ? `\\\\.\\pipe\\geo-popup-smoke-${randomUUID()}` : join(userDataDirectory, 'control.sock'),
      GEO_PUBLISHER_TEST_PLATFORM_URL: `${platformOrigin}/register`,
    },
  });
  const main = await app.firstWindow();
  const waitForPlatformPage = async () => {
    const url = `${platformOrigin}/register`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const page = app.context().pages().find(page => page.url() === url && !page.isClosed());
      if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('platform view did not navigate');
  };
  await main.waitForLoadState('domcontentloaded');
  await main.evaluate(() => window.geoPublisher.createProject({ name: '弹窗测试客户一' }));
  await main.evaluate(() => window.geoPublisher.openPlatform('penguin'));
  const platformPage = await waitForPlatformPage();
  assert.ok(platformPage, 'platform view is missing');

  // Model publisher dashboards that hide the viewport scrollbar even though
  // their content is wider than the embedded browser.
  const originalBounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:'));
    const bounds = window.getBounds();
    window.setSize(920, 700);
    return bounds;
  });
  await platformPage.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'clipped-dashboard-style';
    style.textContent = 'html,body { overflow-x:hidden!important; } html { scrollbar-width:none!important; } html::-webkit-scrollbar { display:none!important; }';
    document.head.append(style);
    const wide = document.createElement('div');
    wide.id = 'wide-dashboard';
    wide.style.cssText = 'width:1300px;display:flex;justify-content:flex-end';
    wide.innerHTML = '<button id="far-right">右侧操作</button>';
    wide.querySelector('button').onclick = () => { wide.dataset.clicked = 'true'; };
    document.body.prepend(wide);
    const tall = document.createElement('div');
    tall.id = 'tall-dashboard';
    tall.style.height = '2000px';
    document.body.append(tall);
  });
  assert.equal(await platformPage.evaluate(() => document.querySelector('#far-right').getBoundingClientRect().right > innerWidth), true);
  await platformPage.waitForFunction(() => document.documentElement.clientHeight < innerHeight);
  assert.equal(await main.evaluate(async () => (await window.geoPublisher.status()).activePlatformZoomFactor), 1, 'horizontal scrolling must keep text at 100%');
  // Drag the real Chromium scrollbar rather than using scrollIntoView(), which
  // would mask a missing or hidden scrollbar.
  const scrollbar = await platformPage.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: innerHeight,
    thumbWidth: document.documentElement.clientWidth ** 2 / document.documentElement.scrollWidth,
  }));
  const dragScrollbar = async (scrollbar) => app.evaluate(async ({ webContents }, { url, scrollbar }) => {
    const contents = webContents.getAllWebContents().find(wc => wc.getURL() === url);
    contents.focus();
    const start = Math.round(scrollbar.thumbWidth / 2);
    const end = scrollbar.width - 20;
    const y = scrollbar.height - 7;
    contents.sendInputEvent({ type: 'mouseMove', x: start, y });
    contents.sendInputEvent({ type: 'mouseDown', x: start, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) {
      contents.sendInputEvent({ type: 'mouseMove', x: Math.round(start + (end - start) * i / 10), y, modifiers: ['leftButtonDown'] });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    contents.sendInputEvent({ type: 'mouseUp', x: end, y, button: 'left', clickCount: 1 });
  }, { url: `${platformOrigin}/register`, scrollbar });
  await dragScrollbar(scrollbar);
  await mkdir(join(process.cwd(), 'release', 'test-evidence'), { recursive: true });
  await platformPage.screenshot({ path: join(process.cwd(), 'release', 'test-evidence', 'platform-horizontal-scroll.png') });
  await platformPage.waitForFunction(() => scrollX > 0 && document.querySelector('#far-right').getBoundingClientRect().right <= innerWidth + 1);
  await platformPage.locator('#far-right').click();
  assert.equal(await platformPage.locator('#wide-dashboard').getAttribute('data-clicked'), 'true');
  await platformPage.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#wide-dashboard').removeAttribute('data-clicked'); });
  // Sohu's real homepage sets body overflow-y:scroll and scrollbar-width:none.
  // That creates a tall BODY scroller; fixing HTML alone cannot expose it.
  await platformPage.evaluate(() => {
    document.querySelector('#clipped-dashboard-style').textContent = 'body { overflow-y:scroll; scrollbar-width:none; }';
  });
  const fallback = platformPage.locator('#geo-platform-horizontal-scroll .bar');
  await fallback.waitFor({ state: 'visible' });
  assert.equal(await platformPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  const fallbackMetrics = () => platformPage.evaluate(() => {
    const bar = document.querySelector('#geo-platform-horizontal-scroll').shadowRoot.querySelector('.bar');
    const rect = bar.getBoundingClientRect();
    return { width: bar.clientWidth, height: rect.bottom, thumbWidth: bar.clientWidth ** 2 / bar.scrollWidth };
  });
  await dragScrollbar(await fallbackMetrics());
  await platformPage.waitForFunction(() => document.body.scrollLeft > 0 && document.querySelector('#far-right').getBoundingClientRect().right <= innerWidth + 1);
  await platformPage.locator('#far-right').click();
  assert.equal(await platformPage.locator('#wide-dashboard').getAttribute('data-clicked'), 'true');
  assert.equal(await platformPage.evaluate(() => scrollY), 0, 'the scrollbar must be reachable without scrolling to the page bottom');
  await platformPage.screenshot({ path: join(process.cwd(), 'release', 'test-evidence', 'platform-body-horizontal-scroll.png') });

  // Also cover a clipped inner application pane and SPA content replacement.
  await platformPage.evaluate(() => {
    document.body.scrollLeft = 0;
    document.querySelector('#wide-dashboard').removeAttribute('data-clicked');
    const pane = document.createElement('main');
    pane.id = 'nested-dashboard';
    pane.style.cssText = 'height:400px;width:100%;overflow:hidden';
    document.body.prepend(pane);
    pane.append(document.querySelector('#wide-dashboard'), document.querySelector('#tall-dashboard'));
  });
  await platformPage.waitForFunction(() => {
    const bar = document.querySelector('#geo-platform-horizontal-scroll').shadowRoot.querySelector('.bar');
    return bar.scrollLeft === 0 && bar.scrollWidth > bar.clientWidth;
  });
  await dragScrollbar(await fallbackMetrics());
  await platformPage.waitForFunction(() => document.querySelector('#nested-dashboard').scrollLeft > 0 && document.querySelector('#far-right').getBoundingClientRect().right <= innerWidth + 1);
  await platformPage.locator('#far-right').click();
  assert.equal(await platformPage.locator('#wide-dashboard').getAttribute('data-clicked'), 'true');
  await platformPage.evaluate(() => {
    document.querySelector('#nested-dashboard').remove();
  });
  await fallback.waitFor({ state: 'hidden' });
  // Restore the original root-overflow fixture for zoom coverage below.
  await platformPage.evaluate(() => {
    document.querySelector('#clipped-dashboard-style').textContent = 'html,body { overflow-x:hidden!important; }';
    const wide = document.createElement('div');
    wide.id = 'wide-dashboard';
    wide.style.cssText = 'width:1300px;display:flex;justify-content:flex-end';
    wide.innerHTML = '<button id="far-right">右侧操作</button>';
    wide.querySelector('button').onclick = () => { wide.dataset.clicked = 'true'; };
    const tall = document.createElement('div');
    tall.id = 'tall-dashboard';
    tall.style.height = '2000px';
    document.body.prepend(wide);
    document.body.append(tall);
  });
  for (let i = 0; i < 5; i++) await main.locator('#platform-zoom-out').click();
  await main.locator('#platform-zoom-reset', { hasText: '50%' }).waitFor();
  assert.equal(await main.locator('#platform-zoom-out').isDisabled(), true);
  await platformPage.waitForFunction(() => document.querySelector('#far-right').getBoundingClientRect().right <= innerWidth);
  await platformPage.locator('#far-right').click();
  assert.equal(await platformPage.locator('#wide-dashboard').getAttribute('data-clicked'), 'true');
  const toolbarFits = await main.evaluate(() => {
    const title = document.querySelector('.platform-toolbar-title').getBoundingClientRect();
    const actions = document.querySelector('.platform-toolbar-actions').getBoundingClientRect();
    return title.right <= actions.left && actions.right <= innerWidth;
  });
  assert.equal(toolbarFits, true, 'platform controls must fit the minimum window width');
  await main.locator('#platform-zoom-reset').click();
  await main.locator('#platform-zoom-reset', { hasText: '100%' }).waitFor();
  await platformPage.locator('h1').click();
  await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(wc => wc.getURL() === url);
    contents.focus();
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    contents.sendInputEvent({ type: 'keyDown', keyCode: '-', modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode: '-', modifiers });
  }, `${platformOrigin}/register`);
  await main.locator('#platform-zoom-reset', { hasText: '90%' }).waitFor();
  await main.locator('#platform-zoom-in').click();
  await main.locator('#platform-zoom-reset', { hasText: '100%' }).waitFor();
  await platformPage.evaluate(() => {
    document.querySelector('#wide-dashboard').remove();
    document.querySelector('#tall-dashboard').remove();
    document.querySelector('#clipped-dashboard-style').remove();
  });
  await platformPage.waitForFunction(() => document.documentElement.scrollWidth === document.documentElement.clientWidth);
  await platformPage.waitForFunction(() => document.documentElement.clientHeight === innerHeight);
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:')).setBounds(bounds);
  }, originalBounds);
  await platformPage.reload();
  await platformPage.evaluate(() => {
    document.documentElement.style.setProperty('overflow-x', 'hidden', 'important');
  });
  await platformPage.waitForFunction(() => getComputedStyle(document.documentElement).overflowX === 'auto');

  const wechatPromise = platformPage.waitForEvent('popup');
  await platformPage.locator('#wechat').click();
  const wechat = await wechatPromise;
  await wechat.locator('#authorize').waitFor();
  assert.equal(await platformPage.evaluate(() => window.blankPopupCreated), true, 'window.open must return a WindowProxy');
  assert.equal(platformPage.url(), `${platformOrigin}/register`, 'registration page must remain open');
  assert.equal(await wechat.evaluate(() => Boolean(window.opener)), true, 'authorization popup lost its opener');
  assert.equal(await app.evaluate(({ BrowserWindow }, origin) =>
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === `${origin}/authorize`)?.isVisible(), authOrigin), true);
  await wechat.locator('#authorize').click();
  await wechat.locator('#complete').waitFor();
  await platformPage.locator('#callback', { hasText: 'authorized' }).waitFor();
  assert.match(await platformPage.evaluate(() => document.cookie), /platform_auth=popup-test/, 'popup must share the project/platform login session');
  await wechat.close();

  const postPromise = platformPage.waitForEvent('popup');
  await platformPage.locator('#post').click();
  const post = await postPromise;
  await post.locator('#post-result', { hasText: 'POST:code=test-value' }).waitFor();
  await post.close();

  await platformPage.locator('#start-loading').click();
  assert.equal(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)?.isLoading(), `${platformOrigin}/register`), true);
  const newtabPromise = platformPage.waitForEvent('popup');
  await platformPage.locator('#newtab').click();
  const newtab = await newtabPromise;
  await newtab.locator('#nested').waitFor();
  const nestedPromise = newtab.waitForEvent('popup');
  await newtab.locator('#nested').click();
  const nested = await nestedPromise;
  await nested.locator('#nested-result').waitFor();
  const sameSession = await app.evaluate(({ webContents }, origin) => {
    const pages = webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(origin));
    return pages.every(wc => wc.session === pages[0].session);
  }, platformOrigin);
  assert.equal(sameSession, true, 'nested windows must inherit the platform session');

  const newtabClosed = newtab.waitForEvent('close');
  const nestedClosed = nested.waitForEvent('close');
  await main.evaluate(() => window.geoPublisher.createProject({ name: '弹窗测试客户二' }));
  await Promise.all([newtabClosed, nestedClosed]);
  assert.equal(nested.isClosed(), true, 'project switch must close nested authorization windows');
  await main.evaluate(() => window.geoPublisher.openPlatform('penguin'));
  const secondPlatformPage = await waitForPlatformPage();
  assert.ok(secondPlatformPage);
  assert.doesNotMatch(await secondPlatformPage.evaluate(() => document.cookie), /platform_auth/, 'login must remain isolated between customer projects');
  process.stdout.write('Platform popup smoke passed: native and fixed horizontal scrollbar drag at 100%, Sohu body overflow, nested pane replacement, clipped dashboard zoom, narrow toolbar, zoom keyboard shortcut, blank window, authorization callback, shared session, POST, loading page, nested windows, project isolation.\n');
} finally {
  if (app) await app.close();
  for (const server of [platformServer, authServer]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}geo-popup-smoke-`)) {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}
