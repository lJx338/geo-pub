import type { LiejuFormOptions } from '../shared/platform-settings.js';

const decode = (value: string) => value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const plain = (value: string) => decode(value.replace(/<[^>]+>/g, '')).trim();
function attribute(tag: string = '', name: string): string {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decode(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

export function liejuFormUrl(cityId: string, categoryId: string): string {
  if (!/^[1-9]\d{0,6}$/.test(cityId) || !/^[1-9]\d{0,6}$/.test(categoryId)) throw new Error('LIEJU_SETTINGS_REQUIRED: 请先选择列举网城市和发布分类');
  return `https://post.lieju.com/${cityId}/${categoryId}`;
}

/** Parse only the public posting form; no account values or scripts are returned. */
export function parseLiejuFormOptions(html: string): LiejuFormOptions {
  if (!/id=["']atc_title["']/.test(html) || !/id=["']atc_content["']/.test(html)) throw new Error('LIEJU_FORM_UNAVAILABLE: 未读取到发布表单，请稍后重试或在平台页面检查分类');
  const fields: LiejuFormOptions['fields'] = [];
  for (const row of html.split(/<div\s+class=["']in["']\s*>/i).slice(1)) {
    const labelHtml = row.match(/<div\s+class=["']m1["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (!labelHtml) continue;
    const label = plain(labelHtml).replace(/[*＊:：]/g, '').trim();
    for (const match of row.matchAll(/<(input|select|textarea)\b([^>]*)(?:>([\s\S]*?)<\/\1\s*>|>)/gi)) {
      const tag = match[2], id = attribute(tag, 'id'), type = attribute(tag, 'type');
      if (!/^atc_[a-zA-Z0-9_]+$/.test(id) || ['hidden', 'file', 'password', 'submit', 'button', 'checkbox', 'radio'].includes(type)) continue;
      if (['atc_title', 'atc_content', 'atc_autofill', 'atc_oicq', 'atc_wechat', 'atc_street_id'].includes(id)) continue;
      const options = match[1]?.toLowerCase() === 'select'
        ? [...(match[3] || '').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((option) => ({ value: attribute(option[1], 'value'), label: plain(option[2] ?? '') })).filter((option) => option.value !== '') : [];
      fields.push({ id, label, required: /[*＊]/.test(plain(labelHtml)), kind: match[1]?.toLowerCase() === 'select' ? 'select' : 'text', options,
        ...(attribute(tag, 'maxlength') ? { maxLength: Number(attribute(tag, 'maxlength')) } : {}) });
    }
  }
  if (!fields.some((field) => field.id === 'atc_zone_id')) throw new Error('LIEJU_FORM_UNAVAILABLE: 发布表单结构已变化，未找到区域选项');
  return { fields };
}

export async function loadLiejuFormOptions(cityId: string, categoryId: string): Promise<LiejuFormOptions> {
  const response = await fetch(liejuFormUrl(cityId, categoryId), { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error('LIEJU_FORM_UNAVAILABLE: 读取列举网分类失败，请稍后重试');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 2_000_000) throw new Error('LIEJU_FORM_UNAVAILABLE: 分类页面响应异常');
  const ascii = new TextDecoder().decode(bytes.slice(0, 2000));
  return parseLiejuFormOptions(new TextDecoder(/charset=["']?utf-8/i.test(ascii) ? 'utf-8' : 'gb18030').decode(bytes));
}
