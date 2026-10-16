import { z } from 'zod';
import type { ArticleDocument } from './article-document.js';

// Design directions distilled from gzh-layout-pro 1.0.0. Components below are
// implemented for our structured document, not copied HTML from the expert.
export const wechatThemes = {
  'moyu-green': { name: '清新绿', accent: '#059669', ink: '#064E3B', soft: '#ECFDF5', line: '#A7F3D0', text: '#334155', radius: 16 },
  'red-white': { name: '经典红白', accent: '#DC2626', ink: '#991B1B', soft: '#FEF2F2', line: '#FECACA', text: '#374151', radius: 10 },
  'graphite-minimal': { name: '石墨极简', accent: '#52525B', ink: '#18181B', soft: '#F4F4F5', line: '#D4D4D8', text: '#3F3F46', radius: 2 },
  'zen-whitespace': { name: '留白墨绿', accent: '#4A5D52', ink: '#334139', soft: '#F4F7F3', line: '#B5C8BC', text: '#4B554E', radius: 4 },
  'moyu-ticket': { name: '绿色票据', accent: '#059669', ink: '#064E3B', soft: '#F0FDF4', line: '#A7F3D0', text: '#334155', radius: 0 },
  'olive-journal': { name: '橙色手记', accent: '#ED7B2F', ink: '#1E1F23', soft: '#FFF7ED', line: '#FED7AA', text: '#414145', radius: 6 },
} as const;

export const wechatLayoutSchema = z.object({
  version: z.literal(1).default(1),
  theme: z.enum(['moyu-green', 'red-white', 'graphite-minimal', 'zen-whitespace', 'moyu-ticket', 'olive-journal']),
  fontSize: z.number().int().min(15).max(18).default(16),
  lineHeight: z.number().min(1.6).max(2.2).default(1.9),
  paragraphSpacing: z.number().int().min(12).max(32).default(20),
  header: z.boolean().default(true),
  eyebrow: z.string().trim().max(32).optional(),
}).strict();
export type WechatLayout = z.infer<typeof wechatLayoutSchema>;

export const articleEmphasisSchema = z.array(z.object({
  text: z.string().trim().min(1).max(120),
  style: z.enum(['bold', 'underline', 'highlight']),
}).strict()).max(8).optional();

export const articleCardSchema = z.object({
  kind: z.enum(['intro', 'note', 'takeaway']),
  label: z.string().trim().max(32).optional(),
}).strict().optional();

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function leaf(text: string): string { return `<span leaf="">${escape(text).replace(/\n/g, '<br>')}</span>`; }

/** No model-supplied HTML, CSS or attributes enter the resulting document. */
export function renderWechatLayoutHtml(document: ArticleDocument, tags: string[]): string {
  const layout = wechatLayoutSchema.parse(document.wechatLayout);
  const theme = wechatThemes[layout.theme];
  const gap = layout.paragraphSpacing;
  const bodyStyle = `font-size:${layout.fontSize}px;line-height:${layout.lineHeight};color:${theme.text};letter-spacing:.5px;`;
  const paragraph = (content: string, margin = gap) => `<p style="margin:0 0 ${margin}px;${bodyStyle}">${content}</p>`;
  const inline = (text: string, emphasis?: z.infer<typeof articleEmphasisSchema>) => {
    // Match literal text, never interpret regular expressions or markup. Longest
    // match wins at a position; stale marks after editing are simply ignored.
    const marks = [...(emphasis ?? [])].sort((a, b) => b.text.length - a.text.length);
    let result = ''; let cursor = 0;
    while (cursor < text.length) {
      const candidates = marks.map((mark) => ({ mark, start: text.indexOf(mark.text, cursor) })).filter((item) => item.start >= 0);
      candidates.sort((a, b) => a.start - b.start || b.mark.text.length - a.mark.text.length);
      const next = candidates[0];
      if (!next) { result += leaf(text.slice(cursor)); break; }
      if (next.start > cursor) result += leaf(text.slice(cursor, next.start));
      const style = next.mark.style === 'bold' ? `font-weight:700;color:${theme.ink};`
        : next.mark.style === 'underline' ? `font-weight:600;border-bottom:2px solid ${theme.line};`
          : `font-weight:600;color:${theme.ink};background-color:${theme.line};padding:1px 2px;`;
      result += `<span style="${style}">${leaf(next.mark.text)}</span>`;
      cursor = next.start + next.mark.text.length;
    }
    return result;
  };
  const html: string[] = [];
  if (layout.header) {
    const headingStyle = layout.theme === 'moyu-ticket' ? `border:1px solid ${theme.accent};border-bottom:4px solid ${theme.accent};`
      : layout.theme === 'graphite-minimal' || layout.theme === 'zen-whitespace' ? `border-top:3px solid ${theme.accent};`
        : `border-bottom:5px solid ${theme.accent};`;
    html.push(`<section style="margin:0 0 ${gap + 8}px;padding:24px 20px;background-color:${theme.soft};border-radius:${theme.radius}px;${headingStyle}">`);
    if (layout.eyebrow) html.push(`<p style="margin:0 0 16px;font-size:12px;font-weight:600;letter-spacing:2px;color:${theme.accent};">${leaf(layout.eyebrow)}</p>`);
    html.push(`<p style="margin:0;font-size:24px;line-height:1.5;font-weight:700;color:${theme.ink};">${leaf(document.title)}</p>`);
    if (document.summary) html.push(`<p style="margin:14px 0 0;font-size:14px;line-height:1.8;color:${theme.text};">${leaf(document.summary)}</p>`);
    html.push('</section>');
  }
  let section = 0;
  for (const block of document.blocks) {
    if (block.type === 'paragraph' || block.type === 'quote') {
      const card = block.card;
      if (card || block.type === 'quote') {
        const kind = card?.kind ?? 'note';
        const border = kind === 'intro' ? `border-top:3px solid ${theme.accent};`
          : kind === 'takeaway' ? `border:1px solid ${theme.line};border-bottom:3px solid ${theme.accent};`
            : `border-left:4px solid ${theme.accent};`;
        const tag = block.type === 'quote' ? 'blockquote' : 'section';
        html.push(`<${tag} style="margin:0 0 ${gap}px;padding:18px 20px;background-color:${theme.soft};border-radius:${theme.radius}px;${border}">`);
        if (card?.label) html.push(`<p style="margin:0 0 10px;font-size:13px;line-height:1.6;font-weight:700;color:${theme.accent};">${leaf(card.label)}</p>`);
        html.push(paragraph(inline(block.text, block.emphasis), 0), `</${tag}>`);
      } else html.push(paragraph(inline(block.text, block.emphasis)));
    } else if (block.type === 'heading') {
      const number = block.level === 2 ? `${String(++section).padStart(2, '0')} / ` : '';
      html.push(`<h${block.level} style="margin:${gap + 12}px 0 14px;padding:0 0 10px;border-bottom:1px solid ${theme.line};font-size:${block.level === 2 ? 20 : 17}px;line-height:1.6;font-weight:700;color:${theme.ink};"><span style="color:${theme.accent};">${leaf(number)}</span>${leaf(block.text)}</h${block.level}>`);
    } else if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      html.push(`<${tag} style="margin:0 0 ${gap}px;padding-left:26px;${bodyStyle}">${block.items.map((item) => `<li style="margin:8px 0;">${leaf(item)}</li>`).join('')}</${tag}>`);
    } else if (block.type === 'divider') {
      html.push(`<hr style="width:48px;margin:${gap + 8}px auto;border:0;border-top:3px solid ${theme.line};">`);
    } else {
      if (!block.src || !/^(https?:\/\/|data:image\/(png|jpeg);base64,)/i.test(block.src)) throw new Error('ARTICLE_IMAGE_UNRESOLVED: 公众号图片需使用素材库或有效图片地址');
      html.push(`<section style="margin:${gap + 4}px 0;">`);
      html.push(`<p style="margin:0;"><span leaf=""><img src="${escape(block.src)}" alt="${escape(block.alt ?? '')}" style="max-width:100%;height:auto;display:block;margin:0 auto;border-radius:${Math.min(theme.radius, 8)}px;"></span></p>`);
      if (block.caption) html.push(`<p style="margin:8px 0 0;font-size:12px;line-height:1.6;text-align:center;color:#6B7280;">${leaf(block.caption)}</p>`);
      html.push('</section>');
    }
  }
  if (tags.length) html.push(`<p style="margin:${gap + 8}px 0 0;padding-top:16px;border-top:1px solid ${theme.line};font-size:12px;line-height:1.8;color:${theme.accent};">${leaf(tags.map((tag) => `#${tag}`).join(' '))}</p>`);
  return `<section style="max-width:677px;margin:0 auto;padding:0 8px;background-color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;word-wrap:break-word;${bodyStyle}">${html.join('')}</section>`;
}
