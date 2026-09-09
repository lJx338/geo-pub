import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

const execFileAsync = promisify(execFile);

const evidenceDirectory = join(process.cwd(), 'release', 'test-evidence');
const workBuddySkillsDirectory = join(process.cwd(), 'release', 'test-workbuddy-skills');
const userDataDirectory = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'GEO Publisher Desktop')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'GEO Publisher Desktop')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'geo-publisher');
await mkdir(evidenceDirectory, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, GEO_DISABLE_OPEN_WORKBUDDY: '1', WORKBUDDY_SKILLS_DIR: workBuddySkillsDirectory },
});

try {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.locator('#platform-progress .progress-item').first().waitFor();
  if ((await window.title()) !== 'GEO Publisher') throw new Error('unexpected window title');

  const initial = await window.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    platformCards: document.querySelectorAll('#platform-progress .progress-item').length,
    navigationButtons: document.querySelectorAll('.nav-button').length,
    connectVisible: Boolean(document.querySelector('#connect-workbuddy')?.getBoundingClientRect().height),
    updateVisible: Boolean(document.querySelector('#check-update')?.getBoundingClientRect().height),
    connectionState: document.querySelector('#connection')?.getAttribute('data-state'),
    updateLabel: document.querySelector('#update-state')?.textContent,
  }));
  if (initial.platformCards !== 6 || initial.navigationButtons !== 2 || !initial.connectVisible || !initial.updateVisible) throw new Error(`initial controls missing: ${JSON.stringify(initial)}`);
  if (initial.scrollWidth > initial.width || initial.scrollHeight > initial.height) throw new Error(`initial layout overflows: ${JSON.stringify(initial)}`);
  if (initial.connectionState !== 'ready' || initial.updateLabel !== '不可用') throw new Error(`initial status is unclear: ${JSON.stringify(initial)}`);

  await window.locator('#nav-tutorial').click();
  if (!(await window.locator('#publishing-view').isHidden()) || !(await window.locator('#tutorial-view').isVisible())) {
    throw new Error('tutorial navigation did not switch views');
  }
  await window.screenshot({ path: join(evidenceDirectory, 'desktop-tutorial.png') });
  await window.locator('#nav-dashboard').click();
  if (!(await window.locator('#publishing-view').isVisible()) || !(await window.locator('#tutorial-view').isHidden())) {
    throw new Error('publishing-center navigation did not switch views');
  }

  const workerStatus = await window.evaluate(async () => await window.geoPublisher.status());
  if (workerStatus.worker?.state !== 'ready' || !workerStatus.worker.pid) throw new Error(`browser worker is not ready: ${JSON.stringify(workerStatus.worker)}`);
  const discovery = JSON.parse(await readFile(join(userDataDirectory, 'discovery.json'), 'utf8'));
  if (discovery.schemaVersion !== 3 || discovery.cliPath !== discovery.launcherPath || !discovery.coreCliPath?.includes('versions')) {
    throw new Error(`launcher discovery record is invalid: ${JSON.stringify(discovery)}`);
  }
  const { stdout: launcherOutput } = await execFileAsync(discovery.launcherPath, ['version', '--json']);
  const launcherVersion = JSON.parse(launcherOutput);
  if (!launcherVersion.ok || launcherVersion.version !== discovery.appVersion) {
    throw new Error(`launcher did not dispatch to the active Core CLI: ${launcherOutput}`);
  }

  if (process.platform === 'win32') {
    const menuVisible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMenuBarVisible());
    if (menuVisible) throw new Error('Windows menu bar should be hidden');
  }

  await window.locator('#connect-workbuddy').click();
  await window.locator('#workbuddy-state', { hasText: '指令已复制' }).waitFor();
  const prompt = await readFile(join(userDataDirectory, 'integrations', 'workbuddy', 'CONNECT-WORKBUDDY.txt'), 'utf8');
  if (!prompt.includes('GEO Publisher Skill') || !prompt.includes('CLI 位置')) throw new Error('WorkBuddy prompt is incomplete');
  await readFile(join(workBuddySkillsDirectory, 'geo-publisher', 'SKILL.md'), 'utf8');

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
  process.stdout.write(`${JSON.stringify({ initial, compact, launcherVersion: launcherVersion.version, screenshot: join(evidenceDirectory, 'desktop-home.png') }, null, 2)}\n`);
} finally {
  await app.close();
}
