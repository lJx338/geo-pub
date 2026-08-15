import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const evidenceDirectory = join(process.cwd(), 'release', 'test-evidence');
const userDataDirectory = join(process.cwd(), 'release', 'test-user-data');
const controlEndpoint = join(userDataDirectory, 'control.sock');
const fixtureUrl = pathToFileURL(join(process.cwd(), 'tests', 'fixtures', 'silent-platform.html')).toString();
const execFileAsync = promisify(execFile);
await rm(userDataDirectory, { recursive: true, force: true });
await mkdir(evidenceDirectory, { recursive: true });
await mkdir(userDataDirectory, { recursive: true });

const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, GEO_DISABLE_OPEN_WORKBUDDY: '1', GEO_PUBLISHER_USER_DATA_DIR: userDataDirectory, GEO_PUBLISHER_CONTROL_ENDPOINT: controlEndpoint, GEO_PUBLISHER_TEST_PLATFORM_URL: fixtureUrl } });
try {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  if ((await window.title()) !== 'GEO Publisher') throw new Error('unexpected window title');
  const initial = await window.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, navigation: document.querySelectorAll('.nav-item').length, connect: Boolean(document.querySelector('#connect-workbuddy')?.getBoundingClientRect().height) }));
  if (initial.navigation < 6 || !initial.connect || initial.scrollWidth > initial.width) throw new Error(`new UI layout is incomplete: ${JSON.stringify(initial)}`);
  await window.locator('#connect-workbuddy').click();
  await window.locator('#workbuddy-state', { hasText: '已连接' }).waitFor();
  const prompt = await readFile(join(userDataDirectory, 'integrations', 'workbuddy', 'CONNECT-WORKBUDDY.txt'), 'utf8');
  if (!prompt.includes('当前客户项目') || !prompt.includes('geo-topic-planner') || !prompt.includes('geo-article-writer') || !prompt.includes('GEO Publisher 安装位置') || !prompt.includes('系统与架构')) throw new Error('WorkBuddy prompt is incomplete');

  const cliPath = process.platform === 'win32' ? join(process.cwd(), '.dev-cli', 'geo-publisher-dev-windows-amd64.exe') : join(process.cwd(), '.dev-cli', 'geo-publisher-dev-darwin-arm64');
  const cliEnv = { ...process.env, GEO_PUBLISHER_USER_DATA_DIR: userDataDirectory, GEO_PUBLISHER_CONTROL_ENDPOINT: controlEndpoint };
  const runCli = async (args) => JSON.parse((await execFileAsync(cliPath, args, { env: cliEnv })).stdout);
  const profilePath = join(userDataDirectory, 'project.json');
  await writeFile(profilePath, JSON.stringify({ name: '冒烟测试客户', companyName: '冒烟测试公司', industry: '企业 AI 服务' }));
  const created = await runCli(['project', 'create', '--input', profilePath]);
  const projectId = created.data?.project?.id;
  if (!projectId) throw new Error(`project creation failed: ${JSON.stringify(created)}`);
  await window.locator('#current-project-title', { hasText: '冒烟测试客户' }).waitFor();
  await window.locator('.nav-item', { hasText: '客户项目' }).click();
  await window.locator('.item-row', { hasText: '冒烟测试客户' }).click();
  await window.locator('.project-sheet').waitFor();
  const projectSheet = await window.evaluate(() => {
    const sheet = document.querySelector('.project-sheet')?.getBoundingClientRect();
    const body = document.querySelector('.project-sheet-body')?.getBoundingClientRect();
    const footer = document.querySelector('.project-sheet-foot')?.getBoundingClientRect();
    return { sheet, body, footer, fields: document.querySelectorAll('.project-sheet input,.project-sheet textarea').length, width: innerWidth, height: innerHeight };
  });
  if (!projectSheet.sheet || !projectSheet.body || !projectSheet.footer || projectSheet.fields < 12 || Math.abs(projectSheet.sheet.right - projectSheet.width) > 2 || projectSheet.footer.bottom > projectSheet.height + 2) throw new Error(`project sheet layout is incomplete: ${JSON.stringify(projectSheet)}`);
  await window.screenshot({ path: join(evidenceDirectory, 'desktop-project-sheet.png') });
  await window.getByRole('button', { name: '关闭客户资料' }).click();
  const articlePath = join(userDataDirectory, 'article.json');
  await writeFile(articlePath, JSON.stringify({ kind: 'article', title: '测试文章', status: 'ready', platform: 'baijia', payload: { document: { title: '测试文章' } } }));
  const saved = await runCli(['content', 'save', projectId, '--input', articlePath]);
  if (!saved.ok) throw new Error(`content save failed: ${JSON.stringify(saved)}`);
  const listed = await runCli(['content', 'list', projectId, 'article']);
  if (listed.data?.items?.[0]?.title !== '测试文章') throw new Error(`content list failed: ${JSON.stringify(listed)}`);
  await window.getByText('内容中心', { exact: true }).click();
  await window.getByText('测试文章', { exact: true }).waitFor();
  await window.screenshot({ path: join(evidenceDirectory, 'desktop-content-center.png') });
  await window.getByText('设置', { exact: true }).click();
  await window.locator('#settings-connect-workbuddy').waitFor();
  const settings = await window.evaluate(async () => {
    const result = await window.geoPublisher.copyDiagnostics();
    const serialized = JSON.stringify(result.diagnostic);
    return {
      cards: document.querySelectorAll('.settings-card').length,
      hasLaunchSwitch: Boolean(document.querySelector('[role="switch"]')),
      hasBetaControl: Boolean(document.querySelector('#beta-invite-code,.beta-panel')),
      diagnosticsSanitized: !/token|cookie|cliPath|dataDirectory|companyName|title/i.test(serialized),
    };
  });
  if (settings.cards !== 4 || !settings.hasLaunchSwitch || !settings.hasBetaControl || !settings.diagnosticsSanitized) throw new Error(`settings UI is incomplete: ${JSON.stringify(settings)}`);
  await window.screenshot({ path: join(evidenceDirectory, 'desktop-settings.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())?.setSize(920, 640));
  await window.waitForTimeout(150);
  const compact = await window.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, sidebarBottom: document.querySelector('.sidebar-bottom')?.getBoundingClientRect().bottom, height: innerHeight }));
  if (compact.scrollWidth > compact.width || (compact.sidebarBottom || 0) > compact.height) throw new Error(`compact UI is clipped: ${JSON.stringify(compact)}`);
  await window.locator('.nav-item', { hasText: '客户项目' }).click();
  await window.locator('.item-row', { hasText: '冒烟测试客户' }).click();
  const compactSheet = await window.evaluate(() => {
    const sheet = document.querySelector('.project-sheet')?.getBoundingClientRect();
    const body = document.querySelector('.project-sheet-body')?.getBoundingClientRect();
    const footer = document.querySelector('.project-sheet-foot')?.getBoundingClientRect();
    return { sheet, body, footer, width: innerWidth, height: innerHeight };
  });
  if (!compactSheet.sheet || !compactSheet.body || !compactSheet.footer || compactSheet.sheet.left < 0 || compactSheet.sheet.right > compactSheet.width + 2 || compactSheet.footer.bottom > compactSheet.height + 2 || compactSheet.body.height < 260) throw new Error(`compact project sheet is clipped: ${JSON.stringify(compactSheet)}`);
  await window.screenshot({ path: join(evidenceDirectory, 'desktop-project-sheet-compact.png') });
  await window.getByRole('button', { name: '关闭客户资料' }).click();

  const inspect = await runCli(['inspect', 'baijia']);
  if (!inspect.ok || inspect.data?.runtimeState !== 'background') throw new Error(`background inspect failed: ${JSON.stringify(inspect)}`);
  const visibleBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((candidate) => candidate.isVisible()).length);
  await runCli(['inspect', 'toutiao']);
  const visibleAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((candidate) => candidate.isVisible()).length);
  if (visibleBefore !== visibleAfter) throw new Error('background inspection changed visible window state');
  process.stdout.write(`${JSON.stringify({ initial, compact, projectId, screenshot: join(evidenceDirectory, 'desktop-project-sheet.png') })}\n`);
} finally { await app.close(); }
