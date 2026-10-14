import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
  await main.waitForLoadState('domcontentloaded');
  await main.evaluate(() => window.geoPublisher.createProject({ name: '弹窗测试客户一' }));
  await main.evaluate(() => window.geoPublisher.openPlatform('penguin'));
  const platformPage = app.context().pages().find((page) => page.url() === `${platformOrigin}/register`);
  assert.ok(platformPage, 'platform view is missing');

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
  const secondPlatformPage = app.context().pages().find(page => page.url() === `${platformOrigin}/register`);
  assert.ok(secondPlatformPage);
  assert.doesNotMatch(await secondPlatformPage.evaluate(() => document.cookie), /platform_auth/, 'login must remain isolated between customer projects');
  process.stdout.write('Platform popup smoke passed: blank window, authorization callback, shared session, POST, loading page, nested windows, project isolation.\n');
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
