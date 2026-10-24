import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const root = await mkdtemp(join(tmpdir(), 'lingxi-startup-'));
const evidenceDirectory = join(process.cwd(), 'release', 'test-evidence');
await mkdir(evidenceDirectory, { recursive: true });
try {
  for (const scenario of ['normal', 'exdev', 'missing-renderer', 'missing-preload', 'missing-html', 'broken-react', 'invalid-projects', 'renderer-crash']) {
    const fixture = join(root, scenario);
    const profile = join(fixture, 'profile');
    await mkdir(profile, { recursive: true });
    await cp('dist', join(fixture, 'dist'), { recursive: true, filter: (path) => !path.split(/[\\/]/).includes('files') && !path.split(/[\\/]/).includes('cli') });
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'startup-fixture', version: '1.0.0', main: 'main.cjs' }));
    // Record native dialogs without requiring a person to click them in CI.
    await writeFile(join(fixture, 'main.cjs'), `
      const { dialog } = require('electron');
      globalThis.startupDialogs = [];
      dialog.showMessageBox = (options) => {
        globalThis.startupDialogs.push(options);
        return new Promise((resolve) => { globalThis.resolveStartupDialog = resolve; });
      };
      globalThis.exdevCount = 0;
      if (${JSON.stringify(scenario)} === 'exdev') {
        const fs = require('node:fs/promises');
        const rename = fs.rename;
        fs.rename = async (source, target) => {
          if (!require('node:path').basename(source).startsWith('.replace-')) {
            globalThis.exdevCount++;
            throw Object.assign(new Error('simulated MSIX cross-device rename'), { code: 'EXDEV' });
          }
          return rename(source, target);
        };
      }
      require('./dist/main/index.cjs');
    `);
    if (scenario === 'missing-renderer') await rm(join(fixture, 'dist/renderer/renderer.js'));
    if (scenario === 'missing-preload') await rm(join(fixture, 'dist/preload.cjs'));
    if (scenario === 'missing-html') await rm(join(fixture, 'dist/renderer/index.html'));
    if (scenario === 'broken-react') {
      const bundle = await readFile(join(fixture, 'dist/renderer/renderer.js'), 'utf8');
      await writeFile(join(fixture, 'dist/renderer/renderer.js'), bundle.replace('function App() {', 'function App() { throw new Error("fixture render failure");'));
    }
    if (scenario === 'invalid-projects') await writeFile(join(profile, 'projects.json'), '{broken');
    const application = await electron.launch({
      args: [fixture], cwd: fixture,
      env: { ...process.env, GEO_DISABLE_OPEN_WORKBUDDY: '1', GEO_PUBLISHER_USER_DATA_DIR: profile,
        GEO_PUBLISHER_CONTROL_ENDPOINT: process.platform === 'win32' ? `\\\\.\\pipe\\lingxi-startup-${process.pid}-${scenario}` : `/tmp/lingxi-${process.pid}-${scenario}.sock` },
    });
    try {
      const logPath = join(profile, 'diagnostics/startup.log');
      if (scenario === 'invalid-projects' || scenario === 'missing-html') {
        const expected = scenario === 'invalid-projects' ? 'MAIN_STARTUP_FAILED' : 'PAGE_LOAD_FAILED';
        await assertEventually(async () => assert.match(await readFile(logPath, 'utf8'), new RegExp(expected)));
        const dialogs = await application.evaluate(() => globalThis.startupDialogs);
        assert.match(dialogs[0].detail, new RegExp(expected));
      } else {
        const page = await application.firstWindow();
        page.setDefaultTimeout(15_000);
        if (scenario === 'normal' || scenario === 'exdev' || scenario === 'renderer-crash') {
          await page.locator('#startup-screen').waitFor({ state: 'hidden' });
          await page.locator('.app-shell').waitFor();
          await assertEventually(async () => assert.match(await readFile(logPath, 'utf8'), /"event":"renderer\.ready"/));
          if (scenario === 'exdev') {
            assert.ok(await application.evaluate(() => globalThis.exdevCount) >= 1);
            assert.equal(JSON.parse(await readFile(join(profile, 'discovery.json'), 'utf8')).ready, true);
            assert.doesNotMatch(await readFile(logPath, 'utf8'), /MAIN_STARTUP_FAILED/);
          }
          if (scenario === 'renderer-crash') {
            await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).webContents.forcefullyCrashRenderer());
            await assertEventually(async () => assert.match(await readFile(logPath, 'utf8'), /RENDERER_PROCESS_GONE/));
            const dialogs = await application.evaluate(() => globalThis.startupDialogs);
            assert.match(dialogs[0].detail, /RENDERER_PROCESS_GONE/);
          }
        } else {
          const expected = { 'missing-renderer': 'SCRIPT_LOAD_FAILED', 'missing-preload': 'PRELOAD_BRIDGE_MISSING', 'broken-react': 'REACT_RENDER_FAILED' }[scenario];
          await page.locator('#startup-actions').waitFor();
          assert.match(await page.locator('#startup-code').innerText(), new RegExp(expected));
          await page.screenshot({ path: join(evidenceDirectory, `startup-${scenario}.png`) });
          await page.locator('#startup-copy').click();
          if (scenario === 'missing-preload') {
            assert.match(await page.locator('#startup-details').inputValue(), /PRELOAD_BRIDGE_MISSING/);
          } else {
            const copied = await application.evaluate(({ clipboard }) => clipboard.readText());
            assert.match(copied, new RegExp(expected));
            assert.match(copied, /startup.begin/);
          }
          const log = await readFile(logPath, 'utf8');
          assert.match(log, new RegExp(scenario === 'missing-preload' ? 'PRELOAD_FAILED' : expected));
          assert.doesNotMatch(log, /renderer.ready/);
        }
      }
      console.log(`Startup smoke passed: ${scenario}`);
    } catch (error) {
      console.error(`Startup smoke failed: ${scenario}`);
      console.error(await readFile(join(profile, 'diagnostics/startup.log'), 'utf8').catch(() => 'No startup log'));
      console.error('Startup windows:', await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ url: window.webContents.getURL() }))).catch(() => []));
      throw error;
    } finally { await application.close(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }

async function assertEventually(check) {
  for (let attempt = 0; ; attempt++) {
    try { await check(); return; }
    catch (error) {
      if (attempt >= 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
