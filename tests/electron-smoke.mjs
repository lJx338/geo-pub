import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
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
await mkdir(evidenceDirectory, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    GEO_DISABLE_OPEN_WORKBUDDY: '1',
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
    connectionState: document.querySelector('#connection')?.getAttribute('data-state'),
    updateLabel: document.querySelector('#update-state')?.textContent,
  }));
  if (initial.platformButtons !== 6 || !initial.connectVisible || !initial.updateVisible) throw new Error(`initial controls missing: ${JSON.stringify(initial)}`);
  if (initial.scrollWidth > initial.width || initial.scrollHeight > initial.height) throw new Error(`initial layout overflows: ${JSON.stringify(initial)}`);
  if (initial.connectionState !== 'ready' || initial.updateLabel !== '不可用') throw new Error(`initial status is unclear: ${JSON.stringify(initial)}`);

  if (process.platform === 'win32') {
    const menuVisible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMenuBarVisible());
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

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(920, 640));
  await window.waitForTimeout(300);
  const compact = await window.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    connectBottom: document.querySelector('#connect-workbuddy')?.getBoundingClientRect().bottom,
    updateBottom: document.querySelector('#check-update')?.getBoundingClientRect().bottom,
  }));
  if (compact.scrollWidth > compact.width || compact.scrollHeight > compact.height) throw new Error(`compact layout overflows: ${JSON.stringify(compact)}`);
  if ((compact.updateBottom || Infinity) > compact.height) throw new Error(`compact controls clipped: ${JSON.stringify(compact)}`);

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
  await window.bringToFront();
  const visibleBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ visible: candidate.isVisible(), focused: candidate.isFocused() })));
  if (!visibleBefore.some((state) => state.visible && state.focused)) throw new Error(`could not focus main window: ${JSON.stringify(visibleBefore)}`);
  const visibleInspect = await runInspect();
  if (!visibleInspect.ok || visibleInspect.data?.runtimeState !== 'background') throw new Error(`visible background inspect failed: ${JSON.stringify(visibleInspect)}`);
  if ('storage' in (visibleInspect.data || {}) || 'valueStart' in (visibleInspect.data || {})) {
    throw new Error('inspect leaked local storage values');
  }
  const visibleAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ visible: candidate.isVisible(), focused: candidate.isFocused() })));
  if (!visibleAfter.some((state) => state.visible && state.focused) || visibleAfter.some((state) => state.visible && !state.focused)) throw new Error(`background inspect changed focus: ${JSON.stringify(visibleAfter)}`);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())?.close());
  const hiddenInspect = await runInspect();
  if (!hiddenInspect.ok || hiddenInspect.data?.runtimeState !== 'background') throw new Error(`hidden background inspect failed: ${JSON.stringify(hiddenInspect)}`);
  const backgroundState = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ visible: candidate.isVisible(), focused: candidate.isFocused() })));
  if (backgroundState.some((state) => state.visible || state.focused)) throw new Error(`background task changed window state: ${JSON.stringify(backgroundState)}`);
  process.stdout.write(`${JSON.stringify({ initial, compact, screenshot: join(evidenceDirectory, 'desktop-home.png') }, null, 2)}\n`);
} finally {
  await app.close();
}
