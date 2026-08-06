import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const evidenceDirectory = join(process.cwd(), 'release', 'test-evidence');
const isolatedUserDataDirectory = join(process.cwd(), 'release', 'test-user-data');
const isolatedControlEndpoint = join(isolatedUserDataDirectory, 'control.sock');
const fixtureUrl = pathToFileURL(join(process.cwd(), 'tests', 'fixtures', 'silent-platform.html')).toString();
const userDataDirectory = isolatedUserDataDirectory;
const execFileAsync = promisify(execFile);
await rm(isolatedUserDataDirectory, { recursive: true, force: true });
await mkdir(evidenceDirectory, { recursive: true });
await mkdir(isolatedUserDataDirectory, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    GEO_DISABLE_OPEN_WORKBUDDY: '1',
    GEO_BETA_INVITE_ALLOW_LOCAL: '1',
    GEO_PUBLISHER_USER_DATA_DIR: isolatedUserDataDirectory,
    GEO_PUBLISHER_CONTROL_ENDPOINT: isolatedControlEndpoint,
    GEO_PUBLISHER_TEST_PLATFORM_URL: fixtureUrl,
  },
});

try {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  if ((await window.title()) !== 'GEO Publisher') throw new Error('unexpected window title');

  const initial = await window.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    platformButtons: document.querySelectorAll('[data-platform]').length,
    connectVisible: Boolean(document.querySelector('#connect-workbuddy')?.getBoundingClientRect().height),
    updateVisible: Boolean(document.querySelector('#check-update')?.getBoundingClientRect().height),
    betaVisible: Boolean(document.querySelector('#beta-access')?.getBoundingClientRect().height),
    betaInHeader: document.querySelector('#beta-access')?.parentElement?.tagName === 'HEADER',
    connectionState: document.querySelector('#connection')?.getAttribute('data-state'),
    updateLabel: document.querySelector('#update-state')?.textContent,
  }));
  if (initial.platformButtons !== 6 || !initial.connectVisible || !initial.updateVisible || !initial.betaVisible || !initial.betaInHeader) throw new Error(`initial controls missing: ${JSON.stringify(initial)}`);
  if (initial.scrollWidth > initial.width || initial.scrollHeight > initial.height) throw new Error(`initial layout overflows: ${JSON.stringify(initial)}`);
  if (initial.connectionState !== 'ready' || initial.updateLabel !== '不可用') throw new Error(`initial status is unclear: ${JSON.stringify(initial)}`);

  if (process.platform === 'win32') {
    const menuVisible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())?.isMenuBarVisible());
    if (menuVisible) throw new Error('Windows menu bar should be hidden');
  }

  await window.locator('#connect-workbuddy').click();
  await window.locator('#workbuddy-state', { hasText: '指令已复制' }).waitFor();
  const prompt = await readFile(join(userDataDirectory, 'integrations', 'workbuddy', 'CONNECT-WORKBUDDY.txt'), 'utf8');
  if (!prompt.includes('GEO Publisher Skill') || !prompt.includes('CLI 位置')) throw new Error('WorkBuddy prompt is incomplete');

  await window.locator('#check-update').click();
  await window.locator('#update-state', { hasText: '不可用' }).waitFor();
  const updateDetail = await window.locator('#update-state').getAttribute('title');
  if (updateDetail !== '开发模式不检查更新') throw new Error(`update detail is missing: ${updateDetail}`);

  await window.locator('#beta-access').click();
  await window.locator('#beta-dialog').waitFor({ state: 'visible' });
  await window.locator('#beta-code').fill('invalid');
  await window.locator('#beta-submit').click();
  await window.locator('#action-message', { hasText: '邀请码格式不正确' }).waitFor();
  await window.locator('#beta-code').fill('BETA-SMOKE01');
  await window.locator('#beta-submit').click();
  await window.locator('#beta-dialog').waitFor({ state: 'hidden' });
  if (await window.locator('#beta-disable').isHidden()) throw new Error('beta channel did not persist in the UI');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())?.setSize(920, 640));
  await window.waitForTimeout(300);
  const compact = await window.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    connectBottom: document.querySelector('#connect-workbuddy')?.getBoundingClientRect().bottom,
    updateBottom: document.querySelector('#check-update')?.getBoundingClientRect().bottom,
    betaBottom: document.querySelector('#beta-disable')?.getBoundingClientRect().bottom,
  }));
  if (compact.scrollWidth > compact.width || compact.scrollHeight > compact.height) throw new Error(`compact layout overflows: ${JSON.stringify(compact)}`);
  if ((compact.updateBottom || Infinity) > compact.height) throw new Error(`compact controls clipped: ${JSON.stringify(compact)}`);
  if ((compact.betaBottom || Infinity) > compact.height) throw new Error(`compact beta controls clipped: ${JSON.stringify(compact)}`);

  await window.screenshot({ path: join(evidenceDirectory, 'desktop-home.png') });
  const cliPath = process.platform === 'win32'
    ? join(process.cwd(), 'dist', 'cli', 'geo-publisher-windows-amd64.exe')
    : join(process.cwd(), 'dist', 'cli', 'geo-publisher-darwin-arm64');
  const cliEnv = {
    ...process.env,
    GEO_PUBLISHER_USER_DATA_DIR: isolatedUserDataDirectory,
    GEO_PUBLISHER_CONTROL_ENDPOINT: isolatedControlEndpoint,
  };
  const runInspect = async () => JSON.parse((await execFileAsync(cliPath, ['inspect', 'baijia'], { env: cliEnv })).stdout);
  const runStatus = async () => JSON.parse((await execFileAsync(cliPath, ['status'], { env: cliEnv })).stdout);
  const visibleBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ visible: candidate.isVisible(), focused: candidate.isFocused() })));
  const visibleInspect = await runInspect();
  if (!visibleInspect.ok || visibleInspect.data?.runtimeState !== 'background') throw new Error(`visible background inspect failed: ${JSON.stringify(visibleInspect)}`);
  if ('storage' in (visibleInspect.data || {}) || 'valueStart' in (visibleInspect.data || {})) {
    throw new Error('inspect leaked local storage values');
  }
  const visibleAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ visible: candidate.isVisible(), focused: candidate.isFocused() })));
  if (visibleAfter.filter((state) => state.visible).length !== visibleBefore.filter((state) => state.visible).length) {
    throw new Error(`background inspect changed the customer's visible window state: before=${JSON.stringify(visibleBefore)}, after=${JSON.stringify(visibleAfter)}`);
  }

  // The detached view must retain a stable desktop viewport and receive real
  // Chromium input events. Platform adapters rely on both facts for upload
  // confirmations and controls that cannot be changed through DOM APIs.
  const hiddenInput = await app.evaluate(async ({ webContents }) => {
    const page = webContents.getAllWebContents().find((candidate) => candidate.getURL().includes('silent-platform.html'));
    if (!page) throw new Error('background fixture WebContents missing');
    const point = await page.executeJavaScript(`(() => {
      const button = document.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) return null;
      button.addEventListener('click', () => { button.dataset.geoClicks = String(Number(button.dataset.geoClicks || 0) + 1); });
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: innerWidth, height: innerHeight };
    })()`);
    if (!point) throw new Error('fixture button missing');
    page.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
    page.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
    page.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const clicks = await page.executeJavaScript(`document.querySelector('button')?.dataset.geoClicks || '0'`);
    return { ...point, clicks };
  });
  if (hiddenInput.width !== 1440 || hiddenInput.height !== 1000 || hiddenInput.clicks !== '1') {
    throw new Error(`detached background view did not accept stable input: ${JSON.stringify(hiddenInput)}`);
  }

  // A login requirement must be reported through the control response while
  // keeping the automation page in the background. It must never surface the
  // desktop window or replace it with the platform page.
  await app.evaluate(({ webContents }) => {
    const page = webContents.getAllWebContents().find((candidate) => candidate.getURL().includes('silent-platform.html'));
    if (!page) throw new Error('background fixture WebContents missing');
    return page.executeJavaScript(`(() => { const input = document.createElement('input'); input.type = 'password'; input.id = 'silent-login-check'; document.body.append(input); })()`);
  });
  const attentionInspect = await runInspect();
  if (attentionInspect.data?.attentionRequired?.code !== 'LOGIN_REQUIRED' || attentionInspect.data?.runtimeState !== 'background') {
    throw new Error(`background login detection was not reported silently: ${JSON.stringify(attentionInspect)}`);
  }
  const attentionStatus = await runStatus();
  if (attentionStatus.data?.attentionRequired?.code !== 'LOGIN_REQUIRED' || attentionStatus.data?.windowState !== 'visible') {
    throw new Error(`background login detection changed desktop visibility: ${JSON.stringify(attentionStatus)}`);
  }

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())?.close());
  const hiddenInspect = await runInspect();
  if (!hiddenInspect.ok || hiddenInspect.data?.runtimeState !== 'background') throw new Error(`hidden background inspect failed: ${JSON.stringify(hiddenInspect)}`);
  const backgroundState = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ visible: candidate.isVisible(), focused: candidate.isFocused() })));
  if (backgroundState.some((state) => state.visible || state.focused)) throw new Error(`background task changed window state: ${JSON.stringify(backgroundState)}`);

  // Finder/Dock activation must restore a deliberately hidden background app
  // on macOS. This event is distinct from second-instance and is how users
  // reopen an app that started through the login-item --background argument.
  await app.evaluate(({ app }) => app.emit('activate'));
  const activatedState = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ visible: candidate.isVisible(), focused: candidate.isFocused() })));
  if (!activatedState.some((state) => state.visible)) throw new Error(`macOS activation did not restore the main window: ${JSON.stringify(activatedState)}`);
  process.stdout.write(`${JSON.stringify({ initial, compact, screenshot: join(evidenceDirectory, 'desktop-home.png') }, null, 2)}\n`);
} finally {
  await app.close();
}
