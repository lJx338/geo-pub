import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const directory = await mkdtemp(join(tmpdir(), 'geo-article-cover-'));
let app;
try {
  const adapter = join(directory, 'adapter.cjs');
  await build({ entryPoints: ['src/main/article-cover.ts'], outfile: adapter, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const entry = join(directory, 'main.cjs');
  await writeFile(entry, `const { app, BrowserWindow } = require('electron');
    global.fillCover = require(${JSON.stringify(adapter)}).fillArticleCover;
    app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(() => new BrowserWindow({ width: 1000, height: 800, show: false,
      webPreferences: { backgroundThrottling: false } }).loadURL('about:blank'));`);
  app = await electron.launch({ args: [entry], executablePath: resolve('node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron') });
  const page = await app.firstWindow();
  const png = 'data:image/png;base64,' + (await readFile('build/icon.png')).toString('base64');
  const setup = async (platform, { old = false, reject = false, select = false, ignoreUpload = false } = {}) => {
    await page.setContent(`<style>body{padding:30px} button{min-width:80px;min-height:35px} img,.pic-cover{width:150px;height:100px} section{padding:20px}.el-dialog{position:absolute;top:250px;background:white;border:1px solid;padding:30px;width:600px}input[type=file]{display:none}</style>
      <div contenteditable=true>正文图片<input id=body-file type=file accept=image/png></div>
      <div role=dialog>确认发布文章<button onclick="window.published=true">确定</button></div>
      <section class="${platform === 'penguin' ? 'articleCoverWrap-fixture' : ''}"><span>${platform === 'zhihu' ? '添加封面' : '封面'}${platform === 'sohu' ? '<i></i><small style="display:none">帮助说明</small>' : ''}</span>
      <div id=preview>${old ? `<img src="${png}#old">` : ''}</div>
      <button id=open class=addCoverBtn-fixture>${old ? '更换封面' : platform === 'zhihu' ? '添加文章封面' : '上传图片'}</button>
      ${platform === 'zhihu' ? '<input id=cover-file type=file accept=image/png>' : ''}</section>
      <script>(()=>{
        const options=${JSON.stringify({ platform, reject, select, ignoreUpload })}; window.uploads=0;window.bodyUploads=0;window.published=false;
        document.querySelector('#body-file').onchange=()=>window.bodyUploads++;
        function apply(src){document.querySelector('#preview').innerHTML=options.platform==='sohu'?'<div class="pic-cover" style="background-image:url('+src+')">编辑封面</div>':'<img src="'+src+'">';document.querySelector('.el-dialog')?.remove();}
        function wire(input){input.onchange=()=>{window.uploads++; if(options.ignoreUpload)return; if(options.reject){const err=document.createElement('div');err.setAttribute('role','alert');err.textContent='图片上传失败';document.body.append(err);return;}
          const src=URL.createObjectURL(input.files[0]);setTimeout(()=>{
            if(options.platform==='zhihu'){apply(src);return;}
            const modal=document.querySelector('.el-dialog');modal.querySelector('#upload-preview').innerHTML='<img src="'+src+'">';
            const confirm=modal.querySelector('#confirm'); if(!options.select)confirm.disabled=false;
            modal.querySelector('img').onclick=()=>{modal.querySelector('#count').textContent='已选择1张';confirm.disabled=false};confirm.onclick=()=>apply(src);
          },300);};}
        document.querySelector('#open').onclick=()=>{
          if(options.platform==='zhihu')return;
          const modal=document.createElement('div');modal.className='el-dialog';modal.setAttribute('role','dialog');
          modal.innerHTML='<h3>封面</h3><button id=local>本地上传</button><div id=local-panel style="display:none"><input id=cover-file type=file accept=image/png></div><div id=upload-preview></div><span id=count>已选择0张</span><button id=confirm disabled>确定</button>';
          document.body.append(modal);modal.querySelector('#local').onclick=()=>{modal.querySelector('#local-panel').style.display='block';};wire(modal.querySelector('input'));
        }; if(options.platform==='zhihu')wire(document.querySelector('#cover-file'));
      })();</script>`);
  };
  const fill = (platform, path = resolve('build/icon.png')) => app.evaluate(({ BrowserWindow }, { platform, path }) => global.fillCover(BrowserWindow.getAllWindows()[0].webContents, platform, path), { platform, path });
  for (const platform of ['zhihu', 'penguin', 'sohu']) {
    await setup(platform, { old: true, select: true });
    assert.deepEqual(await fill(platform), { coverUploaded: true, coverStatus: 'applied' });
    assert.deepEqual(await page.evaluate(()=>({uploads:window.uploads,bodyUploads:window.bodyUploads,published:window.published})),{uploads:1,bodyUploads:0,published:false});
    assert.deepEqual(await fill(platform), { coverUploaded: true, coverStatus: 'applied' });
    assert.equal(await page.evaluate(()=>window.uploads),1,'same file repeat verifies existing preview without duplicate upload');
    await assert.rejects(fill(platform, ''), /COVER_REQUIRED/);
    await setup(platform, { reject: true });
    await assert.rejects(fill(platform), /COVER_NOT_APPLIED.*上传失败/);
    console.log(`${platform}: upload, selection, replacement, repeat, required cover, rejection and publish isolation passed`);
  }
  await setup('zhihu', { old: true, ignoreUpload: true });
  await assert.rejects(fill('zhihu'), /COVER_NOT_APPLIED.*未确认新封面/,'an unchanged old cover cannot pass a failed upload');
  await setup('zhihu');
  await assert.rejects(fill('zhihu', resolve('package.json')), /COVER_FORMAT_UNSUPPORTED/);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.debugger.attach('1.3'));
  await fill('zhihu');
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.debugger.isAttached()),true,'existing debugger is not detached');
  console.log('article cover smoke passed');
} finally { await app?.close(); await rm(directory, { recursive:true, force:true }); }
