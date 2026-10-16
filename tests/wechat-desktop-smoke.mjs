import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

// Runs the actual desktop entry, with an isolated customer store and mocked API.
const root = await mkdtemp(join(tmpdir(), 'geo-wechat-desktop-'));
const imagePath = join(root, 'cover.png');
await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
const env = { ...process.env, GEO_PUBLISHER_USER_DATA_DIR: root, GEO_DISABLE_OPEN_WORKBUDDY: '1',
  GEO_PUBLISHER_CONTROL_ENDPOINT: process.platform === 'win32' ? `\\\\.\\pipe\\geo-publisher-wechat-test-${process.pid}` : join(root, 'control.sock'),
  GEO_PUBLISHER_TEST_PLATFORM_URL: pathToFileURL(join(process.cwd(), 'tests/fixtures/silent-platform.html')).href };
delete env.ELECTRON_RUN_AS_NODE;
const execute = promisify(execFile);
const cliPath = join(process.cwd(), 'dist', 'cli', process.platform === 'win32' ? 'geo-publisher-windows-amd64.exe' : 'geo-publisher-darwin-arm64');
let inputNumber = 0;
async function cli(args, input) {
  if (input !== undefined) {
    const path = join(root, `cli-input-${++inputNumber}.json`);
    await writeFile(path, JSON.stringify(input));
    args = [...args, '--input', path];
  }
  const { stdout } = await execute(cliPath, args, { env, windowsHide: true, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
  const response = JSON.parse(stdout); assert.equal(response.ok, true);
  return response.data;
}
let app;
try {
  app = await electron.launch({ args: ['.', '--background'], cwd: process.cwd(), env });
  const window = await app.firstWindow();
  const errors = []; window.on('pageerror', (error) => errors.push(error.message));
  await window.locator('.app-sidebar').waitFor();
  assert.equal(await window.title(), 'GEO Publisher');
  await app.evaluate(({ dialog }, imagePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imagePath] });
    globalThis.__wechatDesktopTest = { calls: [], drafts: {}, nextId: 1, hold: false, release: null, readFails: false, timeout: false };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); const state = globalThis.__wechatDesktopTest;
      if (url.origin !== 'https://api.weixin.qq.com') throw new Error('Unexpected network endpoint');
      state.calls.push(url.pathname);
      if (url.pathname.endsWith('/stable_token')) return Response.json({ access_token: 'test-token', expires_in: 7200 });
      if (url.pathname.endsWith('/draft/count')) return Response.json({ total_count: 2 });
      if (url.pathname.endsWith('/material/add_material')) return Response.json({ media_id: 'test-cover' });
      if (url.pathname.endsWith('/media/uploadimg')) return Response.json({ url: 'https://mmbiz.qpic.cn/test.png' });
      if (url.pathname.endsWith('/draft/add')) {
        const id = `test-draft-${state.nextId++}`; state.drafts[id] = JSON.parse(init.body).articles[0];
        if (state.hold) await new Promise((resolve) => { state.release = resolve; });
        if (state.timeout) throw new Error('test network timeout');
        return Response.json({ media_id: id });
      }
      if (url.pathname.endsWith('/draft/get')) {
        if (state.readFails) throw new Error('test read failure');
        return Response.json({ news_item: [state.drafts[JSON.parse(init.body).media_id]] });
      }
      throw new Error(`Unexpected WeChat API ${url.pathname}`);
    };
  }, imagePath);
  const projectA = await window.evaluate(async () => (await window.geoPublisher.createProject({ name: '公众号客户 A' })).project.id);
  const projectB = await window.evaluate(async () => (await window.geoPublisher.createProject({ name: '公众号客户 B' })).project.id);
  await window.evaluate((id) => window.geoPublisher.selectProject(id), projectA);
  await window.locator('#project-switch').filter({ hasText: '公众号客户 A' }).waitFor();
  await window.locator('.nav-item').filter({ hasText: '平台账号' }).click();
  await window.locator('.account-grid > section').first().waitFor();
  assert.equal(await window.locator('.account-grid > section').count(), 7);
  await window.getByRole('button', { name: '设置微信公众号连接' }).click();
  await window.locator('#wechat-app-id').fill('wx1234567890abcdef');
  await window.locator('#wechat-app-secret').fill('a'.repeat(32));
  await window.locator('#wechat-save-credentials').click();
  await window.locator('#wechat-connection-message').filter({ hasText: '已加密保存' }).waitFor();
  assert.equal(await window.locator('#wechat-app-secret').inputValue(), '');
  await window.locator('#wechat-test-connection').click();
  await window.locator('#wechat-connection-message').filter({ hasText: '连接正常' }).waitFor();
  await window.evaluate(() => document.fonts.ready);
  const settingsScreenshot = join(root, 'wechat-in-main-settings.png');
  await window.screenshot({ path: settingsScreenshot });
  await window.getByRole('button', { name: '关闭微信公众号连接设置' }).click();
  assert.equal((await readFile(join(root, 'projects', projectA, 'wechat', 'credentials.bin'))).includes(Buffer.from('a'.repeat(32))), false);
  await window.evaluate((id) => window.geoPublisher.selectProject(id), projectB);
  assert.deepEqual(await window.evaluate((id) => window.geoPublisher.wechatSettings(id), projectB), { configured: false, appId: '' });
  const rejectedProject = await window.evaluate(async (id) => {
    try { await window.geoPublisher.wechatSettings(id); return false; } catch (error) { return error.message.includes('PROJECT_CONTEXT_CHANGED'); }
  }, projectA); assert.equal(rejectedProject, true);
  await window.evaluate((id) => window.geoPublisher.selectProject(id), projectA);

  const originalDocument = { title: '在原软件里保存公众号草稿', summary: '原有客户和文章流程的集成验证。', tags: ['公众号草稿'], wechatLayout: { theme: 'moyu-green', eyebrow: '内容工作台' }, blocks: [
    { type: 'paragraph', text: '公众号稿件使用客户自己的连接设置。', card: { kind: 'intro', label: '先确认账号' }, emphasis: [{ text: '客户自己的连接设置', style: 'underline' }] },
    { type: 'heading', level: 2, text: '保存与核对' },
    { type: 'paragraph', text: '先在内容中心确认文章，再将正文与图片一起保存到公众号草稿箱。修改正文后，卡片与配色也应保留下来。' },
    { type: 'quote', text: '草稿保存后再读回核对，避免把请求完成当作内容正确。', card: { kind: 'takeaway', label: '保存后看一眼' }, emphasis: [{ text: '读回核对', style: 'bold' }] },
  ] };
  let article = await window.evaluate(async ({ projectId, imagePath, originalDocument }) => {
    const material = (await window.geoPublisher.contentImportMaterial(projectId, imagePath)).item;
    const document = { ...originalDocument, blocks: [...originalDocument.blocks, { type: 'image', materialId: material.id, caption: '项目素材库图片' }] };
    return (await window.geoPublisher.contentSave(projectId, { kind: 'article', title: document.title, platform: 'wechat', status: 'ready', payload: { document, coverPath: imagePath } })).item;
  }, { projectId: projectA, imagePath, originalDocument });
  await window.locator('.nav-item').filter({ hasText: '内容中心' }).click();
  await window.locator('.content-tabs button').filter({ hasText: '文章' }).click();
  await window.locator('.article-preview-trigger').filter({ hasText: originalDocument.title }).click();
  await window.locator('.wechat-layout-preview').waitFor();
  assert.ok((await window.locator('.wechat-layout-preview').innerHTML()).includes('border-bottom:2px solid #A7F3D0;'));
  await window.getByRole('button', { name: '修改文章', exact: true }).click();
  await window.getByLabel('公众号正文字号').selectOption('17');
  await window.locator('[data-block-index="0"] textarea').fill('公众号稿件使用客户自己的连接设置。编辑后仍保留排版。');
  await window.locator('[data-block-index="0"] summary').click();
  await window.getByLabel('段落卡片样式').first().selectOption('note');
  await window.getByLabel('卡片小标签').first().fill('账号与项目对应');
  // Blur directly into Save: this catches loss of the last emphasis edit.
  await window.getByLabel('高亮短语').first().fill('保留排版');
  await window.getByRole('button', { name: '保存修改', exact: true }).click();
  await window.locator('#article-editor').waitFor({ state: 'detached' });
  article = (await window.evaluate((id) => window.geoPublisher.contentList(id, 'article'), projectA)).items.find((item) => item.id === article.id);
  assert.equal(article.payload.document.wechatLayout.fontSize, 17);
  assert.equal(article.payload.document.blocks[0].card.kind, 'note');
  assert.equal(article.payload.document.blocks[0].emphasis.find((mark) => mark.style === 'highlight').text, '保留排版');
  await window.locator('.article-preview-trigger').filter({ hasText: originalDocument.title }).click();
  await window.locator('.wechat-layout-preview').waitFor();
  assert.ok((await window.locator('.wechat-layout-preview').textContent()).includes('编辑后仍保留排版'));
  const layoutScreenshot = join(root, 'wechat-layout-preview.png');
  await window.locator('.article-preview-sheet').screenshot({ path: layoutScreenshot });
  await window.getByRole('button', { name: '关闭文章预览' }).click();
  await window.locator('.nav-item').filter({ hasText: '分发', exact: false }).first().click();
  const articleRow = window.locator('.distribution-article-row').filter({ hasText: originalDocument.title });
  await articleRow.getByRole('button', { name: '配置分发' }).click();
  await window.locator('.distribution-dialog').getByText('保存到公众号：wx1234567890abcdef', { exact: true }).waitFor();
  assert.equal(await window.locator('input[name="distribution-mode"][value="publish"]').isDisabled(), true);
  await window.locator('#distribution-wechat-title').fill('长'.repeat(33));
  assert.equal(await window.locator('#distribution-run').isDisabled(), true);
  await window.locator('#distribution-wechat-title').fill('公众号专用短标题');
  await window.locator('#distribution-wechat-author').fill('测试作者');
  // The connection dialog is also reachable inside the original distribution dialog.
  await window.locator('.distribution-dialog').getByRole('button', { name: '连接设置', exact: true }).click();
  await window.locator('#wechat-app-id').waitFor();
  assert.equal(await window.locator('#wechat-app-secret').inputValue(), '');
  await window.getByRole('button', { name: '关闭微信公众号连接设置' }).click();
  const distributionScreenshot = join(root, 'wechat-in-main-distribution.png'); await window.screenshot({ path: distributionScreenshot });
  await app.evaluate(() => { globalThis.__wechatDesktopTest.hold = true; });
  await window.locator('#distribution-run').click();
  await window.waitForFunction(async () => { const status = await window.geoPublisher.status(); return status.busy && status.executingPlatform === 'wechat'; });
  await app.evaluate(async () => { while (!globalThis.__wechatDesktopTest.release) await new Promise((resolve) => setTimeout(resolve, 20)); });
  const blocked = await window.evaluate(async (id) => { try { await window.geoPublisher.selectProject(id); return false; } catch (error) { return error.message.includes('PUBLISHER_BUSY'); } }, projectB);
  assert.equal(blocked, true);
  assert.equal((await window.evaluate(() => window.geoPublisher.status())).activePlatform, null);
  await app.evaluate(() => { const state = globalThis.__wechatDesktopTest; state.hold = false; state.release(); });
  await window.locator('.distribution-history-row').filter({ hasText: '草稿已保存' }).waitFor();
  let history = (await window.evaluate((id) => window.geoPublisher.contentList(id, 'distribution'), projectA)).items;
  assert.equal(history.length, 1); assert.equal(history[0].status, 'filled');
  assert.equal(history[0].payload.evidence.verified, true); assert.equal(history[0].payload.evidence.mediaId, 'test-draft-1');
  const savedArticle = (await window.evaluate((id) => window.geoPublisher.contentList(id, 'article'), projectA)).items[0];
  assert.deepEqual(savedArticle.payload.document, article.payload.document); assert.equal(savedArticle.status, 'ready');
  const uploadedArticle = await app.evaluate(() => globalThis.__wechatDesktopTest.drafts['test-draft-1']);
  assert.equal(uploadedArticle.title, '公众号专用短标题'); assert.equal(uploadedArticle.author, '测试作者');
  assert.ok(uploadedArticle.content.includes('https://mmbiz.qpic.cn/test.png')); assert.ok(!uploadedArticle.content.includes('data:image'));
  assert.ok(uploadedArticle.content.includes('font-size:17px;line-height:1.9;'));
  assert.ok(uploadedArticle.content.includes('账号与项目对应'));
  assert.ok(uploadedArticle.content.includes('background-color:#ECFDF5;'));

  // A readback error remains visible in the same distribution record; recheck does not create again.
  await app.evaluate(() => { globalThis.__wechatDesktopTest.readFails = true; });
  const request = { projectId: projectA, articleId: article.id, platforms: ['wechat'], mode: 'fill', coverPath: imagePath,
    platformOptions: { wechat: { title: '公众号专用短标题', author: '测试作者', expectedAppId: 'wx1234567890abcdef' } } };
  const retry = await window.evaluate((request) => window.geoPublisher.runDistribution(request), request);
  assert.equal(retry.records[0].status, 'action_required');
  assert.equal(retry.records[0].payload.evidence.saved, true);
  await app.evaluate(() => { globalThis.__wechatDesktopTest.readFails = false; });
  const rechecked = await window.evaluate(({ id, recordId }) => window.geoPublisher.wechatRecheckDraft(id, recordId), { id: projectA, recordId: retry.records[0].id });
  assert.equal(rechecked.record.id, retry.records[0].id); assert.equal(rechecked.record.status, 'filled');
  assert.equal((await window.evaluate((id) => window.geoPublisher.contentList(id, 'distribution'), projectA)).items.length, 2);
  let calls = await app.evaluate(() => globalThis.__wechatDesktopTest.calls);
  assert.equal(calls.filter((path) => path.endsWith('/draft/add')).length, 1);
  const publishRejected = await window.evaluate(async (request) => {
    try { await window.geoPublisher.runDistribution({ ...request, mode: 'publish', confirmPublish: true }); return false; }
    catch (error) { return error.message.includes('微信公众号目前仅支持保存草稿'); }
  }, request); assert.equal(publishRejected, true);

  await app.evaluate(() => { globalThis.__wechatDesktopTest.timeout = true; });
  const uncertainRequest = { ...request, platformOptions: { wechat: { ...request.platformOptions.wechat, title: '模拟网络中断的另一篇草稿' } } };
  const uncertain = await window.evaluate((request) => window.geoPublisher.runDistribution(request), uncertainRequest);
  assert.equal(uncertain.records[0].status, 'result_uncertain');
  await window.evaluate((request) => window.geoPublisher.runDistribution(request), uncertainRequest);
  calls = await app.evaluate(() => globalThis.__wechatDesktopTest.calls);
  assert.equal(calls.filter((path) => path.endsWith('/draft/add')).length, 2);
  assert.equal(calls.some((path) => /freepublish|mass/.test(path)), false);
  await window.waitForFunction(() => document.querySelector('.distribution-history')?.textContent.includes('结果待确认'));
  assert.ok(!(await window.locator('.distribution-history').textContent()).includes('WECHAT_WRITE_UNCERTAIN'));
  assert.equal(await window.locator('.distribution-history-row').filter({ hasText: '草稿已保存' }).first().locator('small').evaluate((element) => getComputedStyle(element).color), 'rgb(2, 122, 72)');
  const historyScreenshot = join(root, 'wechat-in-main-history.png'); await window.screenshot({ path: historyScreenshot });

  // Exercise the production CLI used by WorkBuddy: one topic, seven distinct saved
  // packages, then the WeChat package through the same desktop API and history.
  await app.evaluate(() => { globalThis.__wechatDesktopTest.timeout = false; });
  const instructions = await cli(['instructions', '--json']);
  assert.deepEqual(instructions.platformOrder, ['baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease', 'wechat']);
  const topic = (await cli(['content', 'save', projectA], { kind: 'topic', title: '设备采购前如何核对需求', status: 'approved',
    payload: { coreQuestion: '设备采购前如何核对需求', directAnswer: '先核对工况和验收条件。', articleType: 'question' } })).item;
  const taskId = 'seven-platform-integration';
  await cli(['topic', 'reserve', projectA, '--topic', topic.id, '--task', taskId]);
  const packages = [];
  for (const [index, platform] of instructions.platformOrder.entries()) {
    await cli(['topic', 'reserve', projectA, '--topic', topic.id, '--task', taskId]);
    const document = { title: topic.title, summary: '采购前核对需求。', tags: ['设备采购', '需求核对'], blocks: [
      { type: 'paragraph', text: `测试平台 ${platform} 的独立内容，验证版本 ${index + 1} 不被覆盖。` },
      article.payload.document.blocks.find((block) => block.type === 'image'),
    ] };
    if (platform === 'wechat') {
      document.wechatLayout = { theme: 'red-white', eyebrow: '采购观察' };
      document.blocks[0].card = { kind: 'intro', label: '先核对需求' };
    }
    packages.push((await cli(['content', 'save', projectA], { kind: 'article', title: document.title, platform, status: 'ready',
      payload: { topicId: topic.id, ...topic.payload, document, coverPath: imagePath } })).item);
  }
  const topicsBeforeUse = (await cli(['content', 'list', projectA, 'topic'])).items;
  assert.equal(topicsBeforeUse.length, 1); assert.equal(topicsBeforeUse[0].usageCount, 0);
  const savedPackages = (await cli(['content', 'list', projectA, 'article'])).items.filter((item) => item.payload.topicId === topic.id);
  assert.equal(savedPackages.length, 7); assert.equal(new Set(savedPackages.map((item) => item.platform)).size, 7);
  assert.equal(new Set(savedPackages.map((item) => JSON.stringify(item.payload.document))).size, 7);
  const wechatPackage = packages.find((item) => item.platform === 'wechat');
  await cli(['topic', 'use', projectA, '--topic', topic.id, '--task', taskId, '--article', wechatPackage.id]);
  const usedTopic = (await cli(['content', 'list', projectA, 'topic'])).items[0];
  assert.equal(usedTopic.usageCount, 1); assert.equal(usedTopic.status, 'used'); assert.equal(usedTopic.reservedBy, '');
  const cliInput = { projectId: projectA, platform: 'wechat', document: wechatPackage.payload.document, coverPath: imagePath,
    platformOptions: { wechat: { author: 'CLI 测试作者', expectedAppId: 'wx1234567890abcdef' } } };
  const validated = await cli(['validate'], cliInput);
  assert.equal(validated.valid, true); assert.equal(validated.coverRequired, true); assert.equal(validated.draftOnly, true);
  const callsBeforeFill = (await app.evaluate(() => globalThis.__wechatDesktopTest.calls)).filter((path) => path.endsWith('/draft/add')).length;
  const cliDraft = await cli(['fill'], cliInput);
  assert.equal(cliDraft.saved, true); assert.equal(cliDraft.verified, true); assert.equal(cliDraft.status, 'filled');
  const cliHistory = (await cli(['content', 'list', projectA, 'distribution'])).items.find((item) => item.payload.articleId === wechatPackage.id);
  assert.equal(cliHistory.payload.source, 'cli'); assert.equal(cliHistory.status, 'filled');
  assert.equal(cliHistory.payload.evidence.mediaId, cliDraft.mediaId);
  const cliUploaded = await app.evaluate((_electron, id) => globalThis.__wechatDesktopTest.drafts[id], cliDraft.mediaId);
  assert.ok(cliUploaded.content.includes('测试平台 wechat 的独立内容'));
  assert.ok(cliUploaded.content.includes('https://mmbiz.qpic.cn/test.png'));
  assert.equal(cliUploaded.author, 'CLI 测试作者');
  assert.ok(cliUploaded.content.includes('background-color:#FEF2F2;'));
  assert.ok(cliUploaded.content.includes('先核对需求'));
  assert.equal((await cli(['fill'], cliInput)).mediaId, cliDraft.mediaId);
  assert.equal((await app.evaluate(() => globalThis.__wechatDesktopTest.calls)).filter((path) => path.endsWith('/draft/add')).length, callsBeforeFill + 1);
  await assert.rejects(cli(['publish'], { ...cliInput, confirmPublish: true }), (error) => JSON.parse(error.stderr).code === 'WECHAT_DRAFT_ONLY');
  await cli(['project', 'select', projectB]);
  await assert.rejects(cli(['fill'], cliInput), (error) => JSON.parse(error.stderr).code === 'PROJECT_CONTEXT_CHANGED');
  // An image from customer A cannot be resolved for customer B, even through CLI.
  const callsBeforeWrongProject = (await app.evaluate(() => globalThis.__wechatDesktopTest.calls)).length;
  await assert.rejects(cli(['fill'], { ...cliInput, projectId: projectB }));
  assert.equal((await app.evaluate(() => globalThis.__wechatDesktopTest.calls)).length, callsBeforeWrongProject);
  assert.equal((await cli(['content', 'list', projectB, 'article'])).items.length, 0);
  await cli(['project', 'select', projectA]);
  assert.ok((await cli(['content', 'list', projectA, 'article'])).items.filter((item) => item.payload.topicId === topic.id).every((item) => item.status === 'ready'));
  assert.equal((await app.evaluate(() => globalThis.__wechatDesktopTest.calls)).some((path) => /freepublish|mass/.test(path)), false);

  // The WeChat backend is attached to the original main window, with its own customer partition.
  await window.evaluate(() => window.geoPublisher.openPlatform('wechat'));
  const platformState = await window.evaluate(() => window.geoPublisher.status());
  assert.equal(platformState.activePlatform, 'wechat');
  const webview = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/renderer/index.html'));
    const child = main.contentView.children.find((view) => view.webContents);
    return { sandbox: child.webContents.getLastWebPreferences().sandbox, contextIsolation: child.webContents.getLastWebPreferences().contextIsolation, url: child.webContents.getURL() };
  });
  assert.equal(webview.sandbox, true); assert.equal(webview.contextIsolation, true);
  await app.evaluate(async ({ session }, projectId) => {
    await session.fromPartition(`persist:geo-publisher-${projectId}-wechat`).cookies.set({ url: 'https://mp.weixin.qq.com', name: 'wechat-test', value: 'customer-a', expirationDate: Date.now() / 1000 + 3600 });
  }, projectA);
  await window.evaluate(() => window.geoPublisher.hidePlatform());
  await window.evaluate((id) => window.geoPublisher.selectProject(id), projectB);
  await window.evaluate(() => window.geoPublisher.openPlatform('wechat'));
  const otherCookies = await app.evaluate(async ({ session }, projectId) => session.fromPartition(`persist:geo-publisher-${projectId}-wechat`).cookies.get({ name: 'wechat-test' }), projectB);
  assert.equal(otherCookies.length, 0);
  await window.evaluate(() => window.geoPublisher.hidePlatform());
  await window.evaluate((id) => window.geoPublisher.selectProject(id), projectA);
  assert.deepEqual(errors, []);
  await app.close(); app = undefined;

  app = await electron.launch({ args: ['.', '--background'], cwd: process.cwd(), env });
  const restored = await app.firstWindow(); await restored.locator('.app-sidebar').waitFor();
  assert.deepEqual(await restored.evaluate((id) => window.geoPublisher.wechatSettings(id), projectA), { configured: true, appId: 'wx1234567890abcdef' });
  await restored.evaluate((id) => window.geoPublisher.deleteProject(id), projectA);
  await assert.rejects(access(join(root, 'projects', projectA, 'wechat', 'credentials.bin')));
  const deletedCookies = await app.evaluate(async ({ session }, projectId) => session.fromPartition(`persist:geo-publisher-${projectId}-wechat`).cookies.get({ name: 'wechat-test' }), projectA);
  assert.equal(deletedCookies.length, 0);
  console.log(JSON.stringify({ passed: true, cliSevenPlatformWorkflow: true, layoutPreviewAndEdit: true, liveWechatRequests: 0, root, settingsScreenshot, layoutScreenshot, distributionScreenshot, historyScreenshot }));
} finally { if (app) await app.close(); }
