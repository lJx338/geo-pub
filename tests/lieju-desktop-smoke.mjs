import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const root = await mkdtemp(join(tmpdir(), 'geo-lieju-desktop-'));
const fixturePath = join(process.cwd(), 'tests/fixtures/lieju-form.html');
const fixture = await readFile(fixturePath, 'utf8');
const imagePath = join(root, 'material.png');

const env = { ...process.env, GEO_PUBLISHER_USER_DATA_DIR: root, GEO_DISABLE_OPEN_WORKBUDDY: '1',
  GEO_PUBLISHER_CONTROL_ENDPOINT: process.platform === 'win32' ? `\\\\.\\pipe\\geo-lieju-test-${process.pid}` : join(root, 'control.sock'),
  GEO_PUBLISHER_TEST_PLATFORM_URL: pathToFileURL(fixturePath).href };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: ['.', '--background'], cwd: process.cwd(), env });
  const window = await app.firstWindow();
  window.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); });
  const errors = []; window.on('pageerror', error => { errors.push(error.message); console.error('renderer:', error.message); });
  await window.locator('.app-sidebar').waitFor();
  await app.evaluate(({ nativeImage }, { fixture, imagePath }) => {
    globalThis.fetch = async input => {
      if (String(input).startsWith('https://post.lieju.com/')) return new Response(fixture);
      throw new Error('Unexpected network request in isolated test');
    };

  }, { fixture, imagePath });
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 128), { width: 32, height: 32 }).toPNG().toString('base64'));
  await writeFile(imagePath, Buffer.from(png, 'base64'));
  const a = await window.evaluate(async () => (await window.geoPublisher.createProject({ name: '列举网客户甲', companyName: '测试公司甲' })).project.id);
  const b = await window.evaluate(async () => (await window.geoPublisher.createProject({ name: '列举网客户乙', companyName: '测试公司乙' })).project.id);
  await window.evaluate(id => window.geoPublisher.selectProject(id), a);
  await window.locator('#project-switch').filter({ hasText: '列举网客户甲' }).waitFor();
  await window.locator('.nav-item').filter({ hasText: '平台账号' }).click();
  await window.locator('.account-grid > section').first().waitFor();
  assert.equal(await window.locator('.account-grid > section').count(), 8);
  await window.getByRole('button', { name: '设置列举网发布默认值' }).click();
  console.log('settings opened');
  await window.locator('#lieju-city').fill('东');
  assert(await window.getByRole('option', { name: '东莞', exact: true }).isVisible());
  assert.equal(await window.getByRole('option', { name: '北京', exact: true }).count(), 0);
  await window.getByRole('option', { name: '东莞', exact: true }).click();
  assert.equal(await window.locator('#lieju-city').inputValue(), '东莞');
  await window.locator('#lieju-group').selectOption({ label: '行业市场' });
  await window.locator('#lieju-category').selectOption('247');
  console.log('category selected');
  await window.locator('#lieju-atc_zone_id').selectOption('296');
  await window.locator('#lieju-atc_leibie').selectOption('2');
  assert.equal(await window.locator('#lieju-company').inputValue(), '测试公司甲');
  assert.equal(await window.locator('#lieju-price').inputValue(), '1');
  await window.locator('#lieju-phone').fill('13800000000');
  await window.locator('#lieju-contact').fill('测试联系人');
  await window.locator('#lieju-city').fill('不存在的城市');
  assert(await window.getByText('未找到城市，请输入城市中文名').isVisible());
  assert(await window.getByRole('button', { name: '保存设置', exact: true }).isDisabled());
  await window.locator('#lieju-city').fill('东莞市');
  await window.locator('#lieju-city').press('ArrowDown');
  await window.locator('#lieju-city').press('Enter');
  assert.equal(await window.locator('#lieju-city').inputValue(), '东莞');
  await window.locator('#lieju-atc_zone_id').selectOption('296');
  await window.evaluate(() => document.fonts.ready);
  await window.screenshot({ path: join(root, 'lieju-settings.png') });
  await window.getByRole('button', { name: '保存设置', exact: true }).click();
  await window.locator('#lieju-settings-title').waitFor({ state: 'detached' });
  await window.evaluate(id => window.geoPublisher.selectProject(id), b);
  const settingsB = await window.evaluate(async () => (await window.geoPublisher.projects()).currentProject.publishingDefaults.lieju);
  assert.equal(settingsB, undefined);
  await window.evaluate(id => window.geoPublisher.selectProject(id), a);
  const article = await window.evaluate(async ({ projectId, imagePath }) => {
    const { item: material } = await window.geoPublisher.contentImportMaterial(projectId, imagePath);
    const { item } = await window.geoPublisher.contentSave(projectId, { kind: 'article', platform: 'lieju', status: 'ready', title: '如何选择适合设备的轴承配件', payload: { document: {
      title: '如何选择适合设备的轴承配件', tags: ['轴承选型', '设备维护'], blocks: [{ type: 'heading', level: 2, text: '先确认使用条件' }, { type: 'paragraph', text: '核对载荷、转速和安装尺寸，结合实际使用环境选择合适的配件。' }, { type: 'image', materialId: material.id, caption: '配件示意图' }],
    } } }); return item;
  }, { projectId: a, imagePath });
  const request = { projectId: a, articleId: article.id, platforms: ['lieju'], mode: 'fill', coverPath: imagePath };
  const result = await window.evaluate(input => window.geoPublisher.runDistribution(input), request);
  assert.equal(result.records[0].status, 'pending_manual', JSON.stringify(result.records[0].payload));
  assert.equal(result.records[0].payload.evidence.primaryClicked, false);
  await app.evaluate(({ webContents }) => { globalThis.__liejuViewId = webContents.getAllWebContents().find(w => w.getURL().includes('lieju-form.html')).id; });
  const state = () => app.evaluate(async ({ webContents }) => {
    const view = webContents.fromId(globalThis.__liejuViewId);
    if (!view) throw new Error('Missing retained platform page');
    return view.executeJavaScript(`({ title: document.querySelector('#atc_title').value, body: document.querySelector('#atc_content').value, company: document.querySelector('#atc_gongsi').value, district: document.querySelector('#atc_zone_id').value, category: document.querySelector('#atc_leibie').value, price: document.querySelector('#atc_danjia').value, contact: document.querySelector('#atc_linkman').value, files: [...document.querySelectorAll('input[type=file]')].flatMap(i => [...i.files].map(f => ({ size: f.size, type: f.type }))), paid: document.querySelector('#paid').checked, qq: document.querySelector('#atc_oicq').value, captcha: window.captchaCount, submits: window.submitCount })`);
  });
  const filled = await state();
  assert.equal(filled.title, article.title); assert.equal(filled.price, '1'); assert.equal(filled.company, '测试公司甲');
  assert.equal(filled.district, '296'); assert.equal(filled.category, '2'); assert.equal(filled.captcha, 1); assert.equal(filled.submits, 0);
  assert.equal(filled.paid, false); assert.equal(filled.qq, '');
  assert.equal(filled.files.length, 2); assert(filled.files.every(file => file.type === 'image/jpeg' && file.size < 1024 * 1024));
  await app.evaluate(async ({ webContents }) => {
    const view = webContents.fromId(globalThis.__liejuViewId);
    await view.executeJavaScript(`document.querySelector('#verify').click()`);
  });
  assert.equal((await state()).submits, 0, 'verification must never trigger automatic submission');
  // Opening another platform must retain the handoff page and its files.
  await window.evaluate(() => window.geoPublisher.openPlatform('zhihu'));
  await window.evaluate(() => window.geoPublisher.openPlatform('lieju'));
  assert.deepEqual(await state(), filled);
  const repeated = await window.evaluate(input => window.geoPublisher.runDistribution(input), request);
  assert.equal(repeated.records[0].payload.error.code, 'LIEJU_PENDING_MANUAL');
  const blocked = await window.evaluate(async input => {
    try { await window.geoPublisher.runDistribution({ ...input, mode: 'publish', confirmPublish: true }); return false; } catch { return true; }
  }, request);
  assert.equal(blocked, true);
  assert.equal((await state()).submits, 0);
  await window.evaluate(() => window.geoPublisher.hidePlatform());
  await window.locator('.nav-item').filter({ hasText: '分发' }).click();
  await window.getByText('已填充，待手动发布', { exact: true }).first().waitFor();
  await window.screenshot({ path: join(root, 'lieju-handoff.png') });
  await window.getByRole('button', { name: '打开列举网', exact: true }).first().click();
  assert.equal((await window.evaluate(() => window.geoPublisher.status())).activePlatform, 'lieju');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, evidenceDirectory: root, checks: ['project settings isolation', 'real UI settings', 'image attachments', 'manual-only handoff', 'no submit after verification', 'pending view retained', 'duplicate fill blocked', 'publish blocked', 'history action'] }));
} catch (error) { const win = await app?.firstWindow(); await win?.screenshot({ path: join(root, 'failure.png') }).catch(() => {}); console.log('Failure artifacts:', root); throw error; } finally { await app?.close(); }
