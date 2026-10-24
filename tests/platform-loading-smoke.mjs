import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const profile = await mkdtemp(join(tmpdir(), 'geo-loading-smoke-'));
let releaseDocument;
const documentGate = new Promise(resolve => { releaseDocument = resolve; });
let mode = 'slow-document';
let requestCount = 0;
const server = createServer(async (request, response) => {
  if (request.url === '/hung-resource') return;
  if (request.url !== '/builder/rc/edit') { response.end(''); return; }
  requestCount++;
  if (mode === 'slow-document') await documentGate;
  if (response.destroyed) return;
  if (mode === 'offline') { response.destroy(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(`<!doctype html><body>
    <script>window.firstViewport = { width: innerWidth, height: innerHeight };</script>
    <h1 id="platform-ready">平台测试页</h1>
    ${mode === 'shell' ? '<iframe src="about:blank"></iframe>' : '<input placeholder="请输入标题"><div contenteditable="true">正文</div>'}
    ${mode === 'hung-resource' ? '<iframe src="/hung-resource"></iframe>' : ''}
  </body>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/builder/rc/edit`;
let app;
try {
  app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: {
    ...process.env,
    GEO_DISABLE_OPEN_WORKBUDDY: '1',
    GEO_PUBLISHER_USER_DATA_DIR: profile,
    GEO_PUBLISHER_CONTROL_ENDPOINT: process.platform === 'win32' ? `\\\\.\\pipe\\geo-loading-${randomUUID()}` : join(profile, 'control.sock'),
    GEO_PUBLISHER_TEST_PLATFORM_URL: url,
  } });
  const main = await app.firstWindow();
  const platformPage = async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const page = app.context().pages().find(p => p.url() === url && !p.isClosed());
      if (page) return page;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`platform page missing: ${app.context().pages().map(p => p.url()).join(', ')}`);
  };
  await main.waitForLoadState('domcontentloaded');
  await main.evaluate(() => window.geoPublisher.createProject({ name: '平台加载诊断测试' }));

  // The HTTP document is deliberately withheld. Open must still return, and
  // the toolbar/notice must remain usable while navigation has not committed.
  await main.evaluate(() => Promise.race([
    window.geoPublisher.openPlatform('baijia'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('open waited for document')), 3_000)),
  ]));
  await main.locator('#platform-page-status').waitFor();
  assert.match(await main.locator('#platform-page-status').innerText(), /正在连接/);
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'slow'), null, { timeout: 15_000 });
  await main.locator('#platform-page-status.slow').waitFor();
  await main.locator('#platform-back').click();
  assert.equal((await main.evaluate(() => window.geoPublisher.status())).activePlatform, null);
  releaseDocument();
  mode = 'normal';
  await main.evaluate(() => window.geoPublisher.openPlatform('baijia'));
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.url.startsWith('http:')));
  let page = await platformPage();
  assert.ok(page);
  await page.locator('#platform-ready').waitFor();
  // History boundaries are normal states; toolbar availability follows both
  // document navigation and SPA history changes.
  await main.waitForFunction(() => document.querySelector('button[aria-label="后退"]').disabled);
  await main.evaluate(() => window.geoPublisher.platformBack());
  await main.evaluate(() => window.geoPublisher.platformForward());
  assert.equal(await main.locator('button[aria-label="前进"]').isDisabled(), true);
  await page.evaluate(() => history.pushState({}, '', '#history-check'));
  await main.waitForFunction(() => !document.querySelector('button[aria-label="后退"]').disabled);
  await main.locator('button[aria-label="后退"]').click();
  await main.waitForFunction(() => !document.querySelector('button[aria-label="前进"]').disabled);
  await main.locator('button[aria-label="前进"]').click();
  await page.waitForURL(`${url}#history-check`);
  await main.waitForFunction(() => document.querySelector('button[aria-label="前进"]').disabled);
  await main.locator('button[aria-label="后退"]').click();
  await page.waitForURL(url);
  await page.goto(`${url}?history-check=1`);
  await main.waitForFunction(() => !document.querySelector('button[aria-label="后退"]').disabled);
  await main.locator('button[aria-label="后退"]').click();
  await page.waitForURL(url);

  // Platform libraries use the browser's native exception and permissions
  // APIs. Exercise the actual preload and navigation injections together.
  const browserApis = await page.evaluate(async () => {
    const permission = await navigator.permissions.query({ name: 'geolocation' });
    const notification = await navigator.permissions.query({ name: 'notifications' });
    class PlatformError extends Error {}
    const cause = new Error('cause');
    const error = new PlatformError('fixture', { cause });
    return {
      errorConstructor: Error.prototype.constructor === Error,
      captureStackTrace: typeof Error.captureStackTrace,
      errorSubclass: error instanceof PlatformError,
      errorCause: error.cause === cause,
      permissionNative: permission instanceof PermissionStatus,
      notificationNative: notification instanceof PermissionStatus,
      permissionEvents: typeof permission.addEventListener,
    };
  });
  assert.deepEqual(browserApis, {
    errorConstructor: true, captureStackTrace: 'function',
    errorSubclass: true, errorCause: true,
    permissionNative: true, notificationNative: true, permissionEvents: 'function',
  });
  assert.deepEqual(await page.evaluate(() => ({
    webdriverOverridden: Object.hasOwn(navigator, 'webdriver'),
    languagesOverridden: Object.hasOwn(navigator, 'languages'),
    userAgentOverridden: Object.hasOwn(navigator, 'userAgent'),
  })), {
    webdriverOverridden: true, languagesOverridden: true, userAgentOverridden: true,
  }, 'Baijia must retain its existing browser environment overrides');
  const first = await page.evaluate(() => window.firstViewport);
  assert.ok(first.width > 0 && first.height > 0, `initial viewport was ${JSON.stringify(first)}`);
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:'));
    return window.contentView.children.find(v => v.webContents?.getURL().startsWith('http:')).getBounds();
  });
  const strip = await main.locator('#platform-page-status').boundingBox();
  assert.ok(bounds.y >= strip.y + strip.height, 'native page must not cover the status strip');

  // A navigation bar and an unrelated iframe do not mean the editor is ready.
  mode = 'shell';
  await main.evaluate(() => window.geoPublisher.platformReopen());
  page = await platformPage();
  await page.locator('#platform-ready').waitFor();
  await main.waitForFunction(() => document.querySelector('#platform-page-status')?.textContent.includes('正在加载平台编辑器'));
  await page.evaluate(() => {
    const title = document.createElement('input');
    title.placeholder = '请输入标题';
    document.body.append(title);
  });
  // Cover at least one further health probe with just the title present.
  await main.waitForTimeout(2_200);
  assert.equal((await main.evaluate(() => window.geoPublisher.status())).platforms.find(p => p.platform === 'baijia').pageState, 'loading');
  await page.evaluate(() => {
    const body = document.createElement('div');
    body.contentEditable = 'true'; body.textContent = '正文';
    document.body.append(body);
  });
  await main.waitForFunction(() => document.querySelector('#platform-page-status')?.textContent.includes('标题和正文编辑器已显示'));

  // Readiness must not read the complete article or force a text layout.
  // Leave the guard installed across multiple periodic probes.
  await page.evaluate(() => {
    window.bodyTextReads = 0;
    Object.defineProperty(document.body, 'innerText', {
      configurable: true,
      get() { window.bodyTextReads++; throw new Error('readiness read the article'); },
    });
  });
  await main.waitForTimeout(2_200);
  assert.equal(await page.evaluate(() => window.bodyTextReads), 0);
  assert.equal((await main.evaluate(() => window.geoPublisher.status())).platforms.find(p => p.platform === 'baijia').pageState, 'ready');

  // Reload without waiting for an unrelated resource. Content and navigation
  // are still accessible while Chromium reports isLoading() == true.
  await page.evaluate(() => { document.cookie = 'session_probe=kept; path=/'; });
  mode = 'hung-resource';
  await main.evaluate(() => window.geoPublisher.platformReopen());
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.url.startsWith('http:')));
  page = await platformPage();
  assert.ok(page);
  await page.locator('#platform-ready').waitFor();
  assert.equal(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(w => w.getURL() === url).isLoading(), url), true);
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'ready'), null, { timeout: 5_000 });
  assert.match(await page.evaluate(() => document.cookie), /session_probe=kept/);
  await main.locator('#platform-back').click();
  await main.locator('.content-area').waitFor({ state: 'visible' });
  await main.evaluate(() => window.geoPublisher.openPlatform('baijia'));
  assert.equal((await main.evaluate(() => window.geoPublisher.status())).activePlatform, 'baijia');

  mode = 'normal';
  await main.evaluate(() => window.geoPublisher.platformReopen());
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'ready'));
  page = await platformPage();
  await page.evaluate(() => {
    const login = document.createElement('div');
    login.className = 'login-panel';
    login.textContent = '发生未知错误，请稍后再试';
    document.body.append(login);
  });
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'login_required'));
  await main.waitForFunction(() => document.querySelector('#platform-page-status')?.textContent.includes('登录或验证码校验未通过'));
  assert.match(await main.locator('#platform-page-status').innerText(), /登录或验证码校验未通过/);
  await page.evaluate(() => document.querySelector('.login-panel').remove());
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'ready'));
  await page.evaluate(() => {
    const notice = document.createElement('div');
    notice.className = 'el-message';
    notice.textContent = 'Error: timeout of 15000ms exceeded';
    document.body.append(notice);
  });
  await main.waitForFunction(() => document.querySelector('#platform-page-status')?.textContent.includes('平台请求超时'));
  await page.evaluate(() => document.querySelector('.el-message').remove());

  // A transport error is retained in the workspace instead of leaving a blank
  // surface. Reopening creates a new page using the same cookie partition.
  mode = 'offline';
  await main.evaluate(() => window.geoPublisher.platformReload());
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'error'));
  await main.locator('#platform-page-status.error').waitFor();
  assert.match(await main.locator('#platform-page-status').innerText(), /失败/);
  mode = 'normal';
  await main.locator('#platform-reopen').click();
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'ready'));
  page = await platformPage();
  assert.match(await page.evaluate(() => document.cookie), /session_probe=kept/);

  const crash = () => app.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(w => w.getURL() === url);
    await new Promise(resolve => { contents.once('render-process-gone', resolve); contents.forcefullyCrashRenderer(); });
  }, url);
  const beforeRecovery = requestCount;
  await crash();
  const recoveryDeadline = Date.now() + 5_000;
  while (requestCount <= beforeRecovery && Date.now() < recoveryDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'ready'));
  assert.ok(requestCount > beforeRecovery, 'idle page must reload after renderer exit');
  await crash();
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'error'));
  const afterSecondCrash = requestCount;
  // Wait longer than the automatic recovery delay to detect restart loops.
  await main.waitForTimeout(1_200);
  assert.equal(requestCount, afterSecondCrash, 'repeated renderer failure must not restart forever');
  await main.locator('#platform-reopen').click();
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'baijia' && p.pageState === 'ready'));

  // Sohu still uses the compatibility preload and page injections. Keep the
  // native Error/Permissions regression covered in that environment too.
  await main.evaluate(() => window.geoPublisher.openPlatform('sohu'));
  await main.waitForFunction(async () => (await window.geoPublisher.status()).platforms.some(p => p.platform === 'sohu' && p.pageState === 'ready'));
  page = await platformPage();
  assert.deepEqual(await page.evaluate(async () => ({
    errorConstructor: Error.prototype.constructor === Error,
    captureStackTrace: typeof Error.captureStackTrace,
    nativePermission: (await navigator.permissions.query({ name: 'geolocation' })) instanceof PermissionStatus,
  })), { errorConstructor: true, captureStackTrace: 'function', nativePermission: true });
  await mkdir(join(process.cwd(), 'release/test-evidence'), { recursive: true });
  await main.screenshot({ path: join(process.cwd(), 'release/test-evidence/platform-loading-status.png') });
  process.stdout.write('Platform loading smoke passed: non-blocking open, initial viewport, responsive navigation, pending resource, retained cookies, login error recovery, network failure, bounded renderer recovery.\n');
} finally {
  releaseDocument();
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
