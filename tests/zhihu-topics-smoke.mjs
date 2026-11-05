import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

// Isolated local fixture: native Electron input and asynchronous topic UI.
const directory = await mkdtemp(join(tmpdir(), 'geo-zhihu-topics-'));
let app;
try {
  const adapter = join(directory, 'adapter.cjs');
  await build({ entryPoints: ['src/main/zhihu-topics.ts'], outfile: adapter, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const entry = join(directory, 'main.cjs');
  await writeFile(entry, `const { app, BrowserWindow } = require('electron');
    global.fillTopics = require(${JSON.stringify(adapter)}).fillZhihuTopics;
    app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(() => new BrowserWindow({ width: 1000, height: 700, show: false,
      webPreferences: { backgroundThrottling: false } }).loadURL('about:blank'));`);
  app = await electron.launch({ args: [entry], executablePath: resolve('node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron') });
  const page = await app.firstWindow();
  const setup = async ({ existing = [], limit = 5, failSelection = false, inline = false, replaceAdd = false, flatSettings = false, missingInput = false, blockedFocus = false, assistantOverlap = false, failRemoval = false, removalDelay = 0 } = {}) => {
    await page.setContent(`<style>
      body { padding: 30px; } #topics { display:flex; gap:10px; align-items:center; margin-top:80px; }
      .slot { display:flex; align-items:center; } input { width:150px; height:32px; }
      button { min-width:24px; min-height:30px; } #results { position:absolute; background:white; z-index:10; }
      #results button { display:block; width:150px; }
    </style><div contenteditable="true">正文 #找不到的话题 #化工</div>
    <div><span>创作声明</span><button>化工</button></div>
    <section>${flatSettings ? '<div>创作声明</div>' : ''}<h4>文章话题${flatSettings ? '\u200b<span>帮助说明</span>' : ''}</h4><div id="topics"><div id="slots"></div><button id="add">添加话题</button></div>${flatSettings ? '<div>内容来源</div>' : ''}</section>
    <div>定时发布</div><div id="results"></div><script>(() => {
      const options = ${JSON.stringify({ existing, limit, failSelection, inline, replaceAdd, missingInput, blockedFocus, assistantOverlap, failRemoval, removalDelay })};
      const slots = document.querySelector('#slots'), add = document.querySelector('#add'), results = document.querySelector('#results');
      if (options.inline) document.querySelector('#topics').append(results);
      window.selected = [...options.existing]; window.lookups = []; window.clicked = []; window.removed = [];
      window.assistantClosed = 0;
      function render() {
        slots.innerHTML = ''; results.innerHTML = '';
        for (const name of window.selected) {
          const slot = document.createElement('div'); slot.className='slot';
          const label = document.createElement('span'); label.textContent=name;
          const remove = document.createElement('button'); remove.setAttribute('aria-label', '移除');
          remove.onclick = () => { if (options.failRemoval) return; setTimeout(() => { window.removed.push(name); window.selected = window.selected.filter(x => x !== name); render(); }, options.removalDelay); };
          slot.append(label, remove); slots.append(slot);
        }
        add.hidden = window.selected.length >= options.limit;
        if (options.replaceAdd && add.hidden) add.remove();
        else if (!add.isConnected) document.querySelector('#topics').append(add);
      }
      add.onclick = () => {
        if (options.missingInput) return;
        if (options.replaceAdd) add.remove();
        const slot = document.createElement('div'); slot.className='slot';
        const input = document.createElement('input'); input.placeholder='搜索话题...'; input.setAttribute('aria-label','搜索话题');
        if (options.blockedFocus) input.onfocus = () => input.blur();
        const remove = document.createElement('button'); remove.onclick=()=>{ slot.remove(); results.innerHTML=''; if (options.replaceAdd) document.querySelector('#topics').append(add); };
        slot.append(input, remove); slots.append(slot);
        if (options.assistantOverlap && !window.assistantClosed && !document.querySelector('aside')) {
          const panel = document.createElement('aside');
          panel.style.cssText = 'position:fixed;top:0;bottom:0;right:0;background:white;z-index:99;left:' + (remove.getBoundingClientRect().left - 1) + 'px';
          const close = document.createElement('button'); close.setAttribute('aria-label', '关闭创作助手'); close.textContent = '关闭';
          close.onclick = () => { window.assistantClosed++; panel.remove(); };
          panel.append(close); document.body.append(panel);
        }
        input.oninput = () => {
          const query = input.value; window.lookups.push(query); results.innerHTML='';
          setTimeout(() => {
            if (!input.isConnected || input.value !== query) return;
            const rect=input.getBoundingClientRect(); results.style.left=rect.left+'px'; results.style.top=rect.bottom+'px';
            const names = query === '国有企业' || query === '已有话题' ? [query] : query === '化工' ? ['化工专业', '化工'] : query === '供应链' ? ['供应链管理','供应链']
              : query === 'CNC' ? ['CNC编程', 'CNC雕刻机', 'CNC加工', 'cnc数控']
              : query === '食品' ? ['食品摄影'] : [];
            for (const name of names) {
              const button=document.createElement('button'); button.textContent=name;
              button.onclick=()=> { window.clicked.push(name); if (options.failSelection) return;
                setTimeout(() => { window.selected.push(name); if (options.replaceAdd) document.querySelector('#topics').append(add); render(); }, 300); };
              results.append(button);
            }
          }, 400);
        };
      };
      render();
    })();</script>`);
  };
  const fill = (tags, articleText = '') => app.evaluate(({ BrowserWindow }, { tags, articleText }) => global.fillTopics(BrowserWindow.getAllWindows()[0].webContents, tags, articleText), { tags, articleText });
  await setup({ existing: ['国有企业', '化工'], limit: 3, replaceAdd: true, flatSettings: true, assistantOverlap: true });
  const thirdTopic = await fill(['国有企业', '化工', 'CNC铣削'], 'CNC铣削加工工艺与精密零件质量');
  if (!thirdTopic.topicsVerified) console.error(JSON.stringify(thirdTopic));
  assert.deepEqual(thirdTopic.topicsApplied, ['国有企业', '化工', 'CNC加工'], 'recognize the third search slot after the add button is removed');
  assert.equal(thirdTopic.topicsVerified, true);
  assert.deepEqual(thirdTopic.topicFailures, []);
  assert.deepEqual(await page.evaluate(() => window.selected), ['国有企业', '化工', 'CNC加工']);
  assert.ok(await page.evaluate(() => window.assistantClosed > 0), 'dismiss the assistant only when it covers the search close control');
  await setup({ existing: ['国有企业', '化工'], limit: 3, replaceAdd: true, flatSettings: true });
  await page.locator('#add').click();
  assert.equal((await fill(['供应链'])).topicsVerified, true, 'reuse an already open last search slot without an add button');
  await setup({ existing: ['国有企业', '化工', '供应链'], limit: 3, replaceAdd: true, flatSettings: true, removalDelay: 300 });
  const switched = await fill(['CNC铣削'], 'CNC铣削加工工艺与精密零件质量');
  assert.equal(switched.topicsVerified, true);
  assert.deepEqual(await page.evaluate(() => window.removed), ['国有企业', '化工', '供应链'], 'remove all old topics even when every slot is occupied');
  assert.deepEqual(await page.evaluate(() => window.selected), ['CNC加工'], 'switching article leaves only the current article topic');
  assert.equal(await page.locator('[contenteditable]').textContent(), '正文 #找不到的话题 #化工', 'topic cleanup never deletes body text');
  await setup({ existing: ['旧话题'], failRemoval: true });
  await assert.rejects(fill(['化工']), /ZHIHU_TOPICS_CLEAR_FAILED.*旧话题/);
  assert.deepEqual(await page.evaluate(() => window.lookups), [], 'stop before new topic searches if removal was not confirmed');
  assert.deepEqual(await page.evaluate(() => window.selected), ['旧话题']);
  await setup();
  let related = await fill(['CNC铣削'], 'CNC铣削加工工艺与精密零件质量');
  assert.deepEqual(related.topicsApplied, ['CNC加工']);
  assert.deepEqual(related.topicsUnmatched, []);
  assert.equal(related.topicsVerified, true);
  assert.deepEqual(related.topicSelections.map(({ requested, selected, match, query }) => ({ requested, selected, match, query })),
    [{ requested: 'CNC铣削', selected: 'CNC加工', match: 'related', query: 'CNC' }]);
  assert.deepEqual(await page.evaluate(() => window.lookups), ['CNC铣削', 'CNC']);
  related = await fill(['CNC铣削'], 'CNC铣削加工工艺与精密零件质量');
  assert.deepEqual(related.topicsApplied, ['CNC加工']);
  assert.deepEqual(await page.evaluate(() => window.selected), ['CNC加工'], 'repeat fallback does not duplicate a selected topic');
  await setup();
  related = await fill(['食品安全'], '食品生产与安全检查');
  assert.equal(related.topicsVerified, false);
  assert.equal(related.topicFailures[0].code, 'NO_MATCH');
  assert.deepEqual(await page.evaluate(() => window.clicked), [], 'unrelated suggestions remain unselected');
  await setup({ existing: ['已有话题'] });
  let result = await fill(['#化工', '化工', '供应链']);
  assert.deepEqual(result.topicsApplied, ['化工', '供应链']);
  assert.equal(result.topicsVerified, true);
  assert.deepEqual(await page.evaluate(() => window.selected), ['化工', '供应链']);
  assert.deepEqual(await page.evaluate(() => window.removed), ['已有话题']);
  result = await fill(['化工', '供应链']);
  assert.equal(result.topicsVerified, true);
  assert.deepEqual(await page.evaluate(() => window.clicked), ['化工', '供应链', '化工', '供应链'], 'repeated replacement does not duplicate topics');
  await setup({ inline: true });
  result = await fill(['找不到的话题', '化工']);
  assert.deepEqual(result.topicsApplied, ['化工']);
  assert.deepEqual(result.topicsUnmatched, ['找不到的话题']);
  assert.equal(result.topicsVerified, false);
  assert.equal(await page.locator('input').count(), 0, 'unfinished search removed');
  assert.deepEqual(await page.evaluate(() => window.clicked), ['化工'], 'body hashtags and fuzzy candidates are not evidence');
  await setup({ existing: ['已有话题'], limit: 1 });
  await page.locator('#add').evaluate(element => element.remove());
  assert.equal((await fill(['已有话题'])).topicsVerified, true, 'recognize selected values when the add button is removed at capacity');
  result = await fill(['化工', '供应链']);
  assert.deepEqual(result.topicsApplied, ['化工']);
  assert.deepEqual(result.topicsUnmatched, ['供应链']);
  assert.equal(result.topicFailures[0].code, 'ADD_UNAVAILABLE');
  assert.equal(result.topicWarnings.length, 1, 'capacity/entry failure is not also reported as no matching topic');
  assert.match(result.topicWarnings[0], /当前已选 1 个/);
  assert.deepEqual(await page.evaluate(() => window.selected), ['化工'], 'old topics release capacity before selecting current topics');
  await setup({ failSelection: true });
  result = await fill(['化工']);
  assert.equal(result.topicsVerified, false, 'a click is not selection evidence');
  assert.deepEqual(result.topicsApplied, []);
  assert.equal(result.topicFailures[0].code, 'SELECTION_UNVERIFIED');
  assert.equal(result.topicWarnings.length, 1);
  await setup({ missingInput: true });
  result = await fill(['化工']);
  assert.equal(result.topicFailures[0].code, 'INPUT_UNAVAILABLE');
  assert.equal(result.topicWarnings.length, 1);
  assert.deepEqual(await page.evaluate(() => window.lookups), [], 'missing input must not be described as a search with no matches');
  await setup({ blockedFocus: true });
  result = await fill(['化工']);
  assert.equal(result.topicFailures[0].code, 'INPUT_FOCUS_FAILED');
  assert.deepEqual(await page.evaluate(() => window.lookups), []);
  await setup();
  await page.locator('#add').evaluate(element => element.disabled = true);
  result = await fill(['化工']);
  assert.equal(result.topicFailures[0].code, 'ADD_UNAVAILABLE');
  assert.match(result.topicWarnings[0], /已禁用/);
  await page.setContent('<div contenteditable="true">#化工</div>');
  await assert.rejects(fill(['化工']), /ZHIHU_TOPICS_CLEAR_FAILED.*未识别/);
  assert.equal((await fill([])).topicsVerified, true);
  console.log('Zhihu topics smoke passed: old topic replacement, full slots, delayed removal, failed removal stops, third slot, fallback, portal/inline, repeat fill, capacity and distinct failures.');
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
