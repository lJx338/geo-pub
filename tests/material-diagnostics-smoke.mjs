import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const root = await mkdtemp(join(tmpdir(), 'lingxi-material-export-'));
const profile = join(root, 'profile');
const evidence = join(process.cwd(), 'release', 'test-evidence');
await mkdir(profile);
await mkdir(evidence, { recursive: true });
let application;
try {
  application = await electron.launch({
    args: ['.'], cwd: process.cwd(),
    env: { ...process.env, GEO_DISABLE_OPEN_WORKBUDDY: '1', GEO_PUBLISHER_USER_DATA_DIR: profile,
      GEO_PUBLISHER_CONTROL_ENDPOINT: process.platform === 'win32' ? '\\\\.\\pipe\\lingxi-material-export-' + process.pid : '/tmp/lingxi-material-export-' + process.pid + '.sock' },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('.app-shell').waitFor();
  const created = await page.evaluate(() => window.geoPublisher.createProject({ name: '日志测试', companyName: '日志测试公司', industry: '设备' }));
  const projectId = created.project.id;
  const source = join(root, 'image.jpg');
  await writeFile(source, 'PRIVATE_IMAGE_BYTES');
  await writeFile(join(profile, 'content', projectId), 'preserved conflicting file');
  const imported = await page.evaluate(({ projectId, source }) => window.geoPublisher.contentImportMaterial(projectId, source), { projectId, source });
  assert.ok(imported.item.payload.sourcePath.includes('material-storage'));
  await page.getByRole('button', { name: '设置', exact: true }).click();

  // Canceling the native save dialog must leave the button ready for another try.
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await page.locator('#export-diagnostic-logs').click();
  await page.getByRole('button', { name: '导出诊断日志', exact: true }).waitFor();

  // A destination that cannot be written must show an actionable error.
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, join(root, 'missing', 'report.json'));
  await page.locator('#export-diagnostic-logs').click();
  await page.locator('#action-message', { hasText: '诊断日志保存失败，请选择其他保存位置后重试' }).waitFor();

  const output = join(root, 'report.json');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await page.locator('#export-diagnostic-logs').click();
  await page.locator('#action-message', { hasText: '诊断日志已保存，可将文件发给技术支持' }).waitFor();
  const text = await readFile(output, 'utf8');
  const report = JSON.parse(text);
  const entries = report.recentLog.split('\n').slice(2).filter(Boolean).map((line) => JSON.parse(line));
  const failure = entries.find((entry) => entry.event === 'material.save-failed');
  const recovery = entries.find((entry) => entry.event === 'material.save-recovered');
  assert.equal(failure.details.stage, 'mkdir');
  assert.ok(['ENOTDIR', 'EEXIST', 'ENOENT'].includes(failure.details.code));
  assert.ok(failure.details.directories.some((directory) => directory.path === join(profile, 'content', projectId) && directory.isDirectory === false));
  assert.equal(recovery.details.destination, imported.item.payload.sourcePath);
  assert.equal(report.storage.contentDirectory, join(profile, 'content'));
  assert.ok(report.app.version);
  assert.ok(!text.includes('PRIVATE_IMAGE_BYTES'));
  await page.locator('#export-diagnostic-logs').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'material-diagnostics-export.png') });
  console.log('Material diagnostic export smoke passed: recovery, cancel, save failure, export');
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
}
