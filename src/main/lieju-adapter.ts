import { readFile } from 'node:fs/promises';
import { nativeImage, type WebContents } from 'electron';
import { renderArticleDocument, type ArticleDocument } from '../shared/article-document.js';
import { liejuSettingsSchema, type LiejuSettings } from '../shared/platform-settings.js';
import { liejuFormUrl } from './lieju-form.js';

export const LIEJU_MANUAL_MESSAGE = '信息已填好，请完成滑块验证、检查内容并手动提交发布。';

export function validateLiejuContent(document: ArticleDocument): string {
  if (document.title.length < 5 || document.title.length > 30) throw new Error('LIEJU_TITLE_INVALID: 列举网标题必须为 5～30 字');
  const text = renderArticleDocument(document, 'lieju').text;
  if (text.length < 10 || text.length > 15000) throw new Error('LIEJU_CONTENT_INVALID: 列举网描述必须为 10～15000 字');
  return text;
}

/** No submit, captcha-solving, or post-verification continuation is part of this adapter. */
export function buildLiejuFillScript(title: string, text: string, settings: LiejuSettings): string {
  const values = { ...settings.extraFields, atc_zone_id: settings.districtId, atc_leibie: settings.subcategoryId,
    atc_gongsi: settings.company, atc_mobphone: settings.phone, atc_linkman: settings.contact,
    atc_danjia: settings.price, atc_title: title, atc_content: text };
  return `(() => {
    const form = document.querySelector('form#form');
    if (!form || !form.querySelector('#atc_title') || !form.querySelector('#atc_content')) throw new Error('LIEJU_FORM_MISSING: 未找到列举网发布表单');
    if (document.querySelector('#atc_editpwd') || /游客不允许上传/.test(document.body.innerText)) throw new Error('LOGIN_REQUIRED: 请先在列举网登录，再执行填充');
    if (/免费信息已用完|发布条数已用完|发布次数已用完/.test(document.body.innerText)) throw new Error('LIEJU_QUOTA_EXHAUSTED: 当前账号发布额度已用完');
    const values = ${JSON.stringify(values)};
    const category = form.querySelector('input[name=fid]');
    if (category && category.value !== ${JSON.stringify(settings.categoryId)}) throw new Error('LIEJU_OPTION_CHANGED: 发布分类已变化，请重新选择');
    const missing = [];
    for (const [id, value] of Object.entries(values)) {
      const field = form.querySelector('#' + id);
      if (!field) { if (['atc_zone_id','atc_title','atc_content','atc_mobphone','atc_linkman'].includes(id)) missing.push(id); continue; }
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) continue;
      if (field instanceof HTMLInputElement && !['text','number','tel'].includes(field.type)) continue;
      if (field instanceof HTMLSelectElement && value && ![...field.options].some(option => option.value === value)) throw new Error('LIEJU_OPTION_CHANGED: ' + id + ' 的选项已变化，请重新保存列举网发布设置');
      if (field.maxLength > 0 && value.length > field.maxLength) throw new Error('LIEJU_FIELD_INVALID: ' + id + ' 超过页面字数限制');
      const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.dispatchEvent(new Event('blur', { bubbles: true }));
      if (field.value.replace(/\\r\\n/g,'\\n') !== value.replace(/\\r\\n/g,'\\n')) throw new Error('LIEJU_FILL_MISMATCH: 字段回读不一致：' + id);
    }
    for (const row of form.querySelectorAll('.in')) {
      const label = row.querySelector('.m1')?.textContent || '';
      if (!/[*＊]/.test(label) || /验证码/.test(label)) continue;
      const fields = [...row.querySelectorAll('input:not([type=hidden]):not([type=submit]),select,textarea')].filter(field => field.getBoundingClientRect().height > 0);
      const controls = fields.filter(field => field.id !== 'atc_street_id' && field.type !== 'file');
      if (controls.some(field => ['radio','checkbox','password'].includes(field.type))) throw new Error('LIEJU_UNSUPPORTED_FIELD: 该分类还有需要手动填写的必填项：' + label.trim());
      if (controls.some(field => !field.value.trim() || !(field.id in values))) missing.push(label.trim());
    }
    if (missing.length) throw new Error('LIEJU_REQUIRED_FIELDS: 请补齐列举网设置：' + missing.join('、'));
    const errors = [...form.querySelectorAll('.Validform_wrong')].filter(element => element.getBoundingClientRect().height > 0 && !/验证码/.test(element.closest('.in')?.querySelector('.m1')?.textContent || '')).map(element => element.textContent.trim());
    if (errors.length) throw new Error('LIEJU_FIELD_INVALID: ' + errors.join('；'));
    // Do not inherit optional contact data or paid promotion from a previous post.
    for (const id of ['atc_oicq','atc_wechat']) { const field = form.querySelector('#' + id); if (field) field.value = ''; }
    for (const row of form.querySelectorAll('.in')) if (/付费推广/.test(row.querySelector('.m1')?.textContent || '')) for (const field of row.querySelectorAll('input[type=checkbox]')) { field.checked = false; field.dispatchEvent(new Event('change', { bubbles: true })); }
    const autofill = form.querySelector('#atc_autofill'); if (autofill) autofill.value = '0';
    return { titleFilled: true, bodyFilled: true };
  })()`;
}

export function buildLiejuHandoffScript(): string {
  return `(() => {
    const form = document.querySelector('form#form');
    if (!form) throw new Error('LIEJU_FORM_MISSING: 发布页面已离开');
    for (const row of form.querySelectorAll('.in')) {
      if (!/[*＊]/.test(row.querySelector('.m1')?.textContent || '')) continue;
      const files = [...row.querySelectorAll('input[type=file]')];
      if (files.length && !files.some(field => field.files?.length)) throw new Error('LIEJU_REQUIRED_FIELDS: 该分类要求上传图片，请选择封面或正文素材');
    }
    const trigger = [...form.querySelectorAll('a,button,input[type=button],span')].find(element => (element.innerText || element.value || '').trim() === '点击显示验证码');
    if (trigger) { trigger.scrollIntoView({ block: 'center' }); trigger.click(); }
    else form.querySelector('#sub')?.scrollIntoView({ block: 'center' });
    window.__geoLiejuPending = true;
    return { captchaRequested: !!trigger, status: 'pending_manual', stage: 'manual_handoff', message: ${JSON.stringify(LIEJU_MANUAL_MESSAGE)}, url: location.href, primaryClicked: false, confirmationClicked: false };
  })()`;
}

async function imageData(source: string, local: boolean): Promise<{ name: string; data: string }> {
  let bytes: Buffer;
  if (local) bytes = await readFile(source);
  else if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(source)) bytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64');
  else throw new Error('LIEJU_IMAGE_SOURCE: 列举网图片请使用当前客户素材库的 materialId');
  let bitmap = nativeImage.createFromBuffer(bytes);
  if (bitmap.isEmpty()) throw new Error('LIEJU_IMAGE_INVALID: 无法读取图片');
  const size = bitmap.getSize();
  if (Math.max(size.width, size.height) > 1600) bitmap = bitmap.resize(size.width >= size.height ? { width: 1600 } : { height: 1600 });
  for (const quality of [90, 80, 65, 45]) {
    const jpeg = bitmap.toJPEG(quality);
    if (jpeg.length < 1024 * 1024) return { name: 'lieju-image.jpg', data: jpeg.toString('base64') };
  }
  throw new Error('LIEJU_IMAGE_TOO_LARGE: 压缩后图片仍超过 1 MB，请更换图片');
}

async function fillImages(webContents: WebContents, images: Array<{ name: string; data: string }>): Promise<void> {
  for (let index = 0; index < images.length; index++) {
    const result = await webContents.executeJavaScript(`(() => {
      const form = document.querySelector('form#form');
      const inputs = () => [...form.querySelectorAll('input[type=file]')];
      let field = inputs()[${index}];
      if (!field) {
        const more = [...form.querySelectorAll('a,button,span')].find(element => (element.innerText || '').trim() === '上传更多');
        if (more) more.click();
        field = inputs()[${index}];
      }
      if (!field) return false;
      const image = ${JSON.stringify(images[index])};
      const bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], image.name, { type: 'image/jpeg' }));
      field.files = transfer.files;
      field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }));
      return field.files?.length === 1 && field.files[0].size === bytes.length;
    })()`);
    if (!result) throw new Error('LIEJU_IMAGE_UPLOAD_FAILED: 未找到足够的图片上传位置，请在平台页面检查');
  }
}

export async function fillLiejuDraft(webContents: WebContents, document: ArticleDocument, coverPath: string, rawSettings?: Partial<LiejuSettings>) {
  const settings = liejuSettingsSchema.parse(rawSettings ?? {});
  const url = liejuFormUrl(settings.cityId, settings.categoryId);
  if (!settings.districtId || !settings.phone || !settings.contact) throw new Error('LIEJU_SETTINGS_REQUIRED: 请先在平台账号中完善列举网地区、电话和联系人');
  if (!/^[0-9]{6,12}$|^[0-9]{3,4}-[0-9]{6,8}(?:-[0-9]{1,6})?$/.test(settings.phone)) throw new Error('LIEJU_FIELD_INVALID: 联系电话格式不正确');
  const text = validateLiejuContent(document);
  if (await webContents.executeJavaScript('Boolean(window.__geoLiejuPending)')) throw new Error('LIEJU_PENDING_MANUAL: 当前页面还有待手动发布的信息，请先提交；如需放弃，请手动刷新页面后重新填充');
  const images: Array<{ name: string; data: string }> = [];
  if (coverPath) images.push(await imageData(coverPath, true));
  for (const block of document.blocks) if (block.type === 'image') {
    if (!block.src) throw new Error('LIEJU_IMAGE_SOURCE: 正文图片尚未解析，请使用当前客户素材库');
    images.push(await imageData(block.src, false));
  }
  // The site's category links lead directly to this form. Validated numeric IDs
  // select the configured city and category without relying on the last page.
  await webContents.loadURL(process.env.GEO_PUBLISHER_TEST_PLATFORM_URL || url);
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await webContents.executeJavaScript('Boolean(document.querySelector("form#form #atc_content"))').catch(() => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  if (!ready) throw new Error('LIEJU_FORM_MISSING: 发布表单未就绪，请打开列举网检查登录或页面验证');
  await webContents.executeJavaScript(buildLiejuFillScript(document.title, text, settings));
  await fillImages(webContents, images);
  const result = await webContents.executeJavaScript(buildLiejuHandoffScript());
  return { ...result, titleFilled: true, bodyFilled: true, imageCount: images.length };
}
