import { z } from 'zod';

export const articleBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string().trim().min(1).max(12_000) }),
  z.object({ type: z.literal('heading'), level: z.union([z.literal(2), z.literal(3)]), text: z.string().trim().min(1).max(240) }),
  z.object({ type: z.literal('list'), ordered: z.boolean().default(false), items: z.array(z.string().trim().min(1).max(500)).min(1).max(30) }),
  z.object({ type: z.literal('quote'), text: z.string().trim().min(1).max(2_000) }),
  z.object({ type: z.literal('divider') }),
  z.object({ type: z.literal('image'), src: z.string().trim().url(), alt: z.string().trim().max(200).optional() }),
]);

export const articleDocumentSchema = z.object({
  title: z.string().trim().min(2).max(100),
  blocks: z.array(articleBlockSchema).min(1).max(120),
  summary: z.string().trim().max(120).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(9).default([]),
});

export type ArticleBlock = z.infer<typeof articleBlockSchema>;
export type ArticleDocument = z.infer<typeof articleDocumentSchema>;

export type ArticlePlatform = 'baijia' | 'toutiao' | 'zhihu' | 'penguin' | 'sohu' | 'netease';

export type ArticleRender = {
  html: string;
  text: string;
  structuralExpectations: {
    headings: number;
    lists: number;
    quotes: number;
    dividers: number;
    images: number;
  };
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraphHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
}

/**
 * Render the portable document into the smallest safe HTML subset accepted by
 * a platform editor. The document remains the source of truth; this is only a
 * presentation conversion. Some Draft.js based editors intentionally flatten
 * unsupported blocks instead of receiving HTML they silently corrupt.
 */
export function renderArticleDocument(document: ArticleDocument, platform?: ArticlePlatform): ArticleRender {
  const expectations = { headings: 0, lists: 0, quotes: 0, dividers: 0, images: 0 };
  const html: string[] = [];
  const text: string[] = [];

  for (const block of document.blocks) {
    if (block.type === 'paragraph') {
      html.push(paragraphHtml(block.text));
      text.push(block.text);
      continue;
    }
    if (block.type === 'heading') {
      if (platform === 'netease') {
        // 网易号 Draft.js currently turns h2/h3 into anonymous blocks. Bold
        // paragraph text preserves the visual hierarchy without reporting a
        // false structural failure or leaking literal Markdown markers.
        html.push(`<p><strong>${escapeHtml(block.text)}</strong></p>`);
      } else {
        expectations.headings += 1;
        html.push(`<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`);
      }
      text.push(block.text);
      continue;
    }
    if (block.type === 'list') {
      expectations.lists += 1;
      const tag = block.ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`);
      text.push(block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${item}`).join('\n'));
      continue;
    }
    if (block.type === 'quote') {
      expectations.quotes += 1;
      html.push(`<blockquote>${escapeHtml(block.text).replace(/\n/g, '<br>')}</blockquote>`);
      text.push(block.text);
      continue;
    }
    if (block.type === 'divider') {
      if (platform !== 'netease') {
        expectations.dividers += 1;
        html.push('<hr>');
      }
      continue;
    }
    expectations.images += 1;
    html.push(`<p><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt ?? '')}"></p>`);
    text.push(block.alt || '配图');
  }

  return { html: html.join(''), text: text.join('\n\n').trim(), structuralExpectations: expectations };
}

export function articleDocumentFromLegacy(title: string, html: string, tags: string[]): ArticleDocument {
  const text = html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, blocks: [{ type: 'paragraph', text: text || title }], tags };
}
