import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const evidenceDirectory = join(process.cwd(), 'release', 'test-evidence');
const userDataDirectory = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'GEO Publisher Desktop')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'GEO Publisher Desktop')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'geo-publisher');
await mkdir(evidenceDirectory, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, GEO_DISABLE_OPEN_WORKBUDDY: '1' },
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
  }));
  if (initial.platformButtons !== 6 || !initial.connectVisible || !initial.updateVisible) throw new Error(`initial controls missing: ${JSON.stringify(initial)}`);
  if (initial.scrollWidth > initial.width || initial.scrollHeight > initial.height) throw new Error(`initial layout overflows: ${JSON.stringify(initial)}`);

  await window.locator('#connect-workbuddy').click();
  await window.locator('#workbuddy-state', { hasText: '指令已复制' }).waitFor();
  const prompt = await readFile(join(userDataDirectory, 'integrations', 'workbuddy', 'CONNECT-WORKBUDDY.txt'), 'utf8');
  if (!prompt.includes('GEO Publisher Skill') || !prompt.includes('CLI 位置')) throw new Error('WorkBuddy prompt is incomplete');

  await window.locator('#check-update').click();
  await window.locator('#update-state', { hasText: '开发模式不检查更新' }).waitFor();

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
  process.stdout.write(`${JSON.stringify({ initial, compact, screenshot: join(evidenceDirectory, 'desktop-home.png') }, null, 2)}\n`);
} finally {
  await app.close();
}
