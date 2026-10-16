import { describe, expect, it } from 'vitest';
import { articleDocumentSchema, renderArticleDocument } from './article-document.js';
import { wechatThemes } from './wechat-layout.js';
import { makeWechatArticle, prepareDocument, verifyWechatDraft } from '../main/wechat/document.js';

const input = {
  title: '采购前怎样判断样品', summary: '先确认测试条件。', tags: ['样品验证'],
  wechatLayout: { theme: 'moyu-green' },
  blocks: [
    { type: 'paragraph', text: '先确认测试条件，再比较结果。', card: { kind: 'intro', label: '看点' }, emphasis: [{ text: '测试条件', style: 'underline' }] },
    { type: 'heading', level: 2, text: '明确工况' },
    { type: 'heading', level: 3, text: '记录温度' },
    { type: 'heading', level: 2, text: '统一验收' },
    { type: 'list', ordered: false, items: ['确认工况', '记录口径'] },
    { type: 'quote', text: '先核对，再下单。', card: { kind: 'takeaway', label: '采购下一步' } },
    { type: 'divider' },
  ],
};

describe('WeChat layout document', () => {
  it.each(Object.keys(wechatThemes))('renders %s into inline styles without changing source text', (theme) => {
    const document = articleDocumentSchema.parse({ ...input, wechatLayout: { theme } });
    const before = JSON.stringify(document);
    const rendered = renderArticleDocument(document, 'wechat');
    expect(rendered.html).toContain('font-size:16px;line-height:1.9;');
    expect(rendered.html).toContain('01 / '); expect(rendered.html).toContain('02 / '); expect(rendered.html).not.toContain('03 / ');
    expect(rendered.html).toContain('采购下一步'); expect(rendered.html).toContain('#样品验证');
    expect(rendered.html).not.toMatch(/<(script|style|iframe)\b|\b(class|id)=/);
    expect(rendered.text).toContain('先确认测试条件，再比较结果。');
    expect(JSON.stringify(document)).toBe(before);
  });

  it('preserves the original output for legacy articles and every other platform', () => {
    const styled = articleDocumentSchema.parse(input);
    const plain = articleDocumentSchema.parse({ ...input, wechatLayout: undefined });
    for (const platform of ['baijia', 'toutiao', 'zhihu', 'penguin', 'sohu', 'netease'] as const) {
      expect(renderArticleDocument(styled, platform)).toEqual(renderArticleDocument(plain, platform));
      expect(renderArticleDocument(styled, platform).html).not.toContain('style=');
    }
    expect(renderArticleDocument(plain, 'wechat')).toEqual(renderArticleDocument(plain));
  });

  it('escapes text and attributes, handles overlapping marks and ignores removed phrases', () => {
    const document = articleDocumentSchema.parse({ ...input, wechatLayout: { theme: 'moyu-green', eyebrow: '<img onerror=alert(1)>' }, blocks: [
      { type: 'paragraph', text: '测试条件 <script>alert(1)</script> & 测试', card: { kind: 'note', label: '<iframe>' }, emphasis: [
        { text: '测试', style: 'bold' }, { text: '测试条件', style: 'highlight' }, { text: '已删除', style: 'underline' },
      ] },
    ] });
    const html = renderArticleDocument(document, 'wechat').html;
    expect(html).not.toMatch(/<(script|iframe|img)\b/);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('已删除');
    expect(html).toContain('<span leaf="">测试条件</span>');
  });

  it('rejects invented themes, raw CSS and unsupported versions at the contract boundary', () => {
    for (const wechatLayout of [{ theme: 'invented' }, { theme: 'moyu-green', version: 2 }, { theme: 'moyu-green', fontSize: 40 }, { theme: 'moyu-green', style: 'position:fixed' }]) {
      expect(articleDocumentSchema.safeParse({ ...input, wechatLayout }).success).toBe(false);
    }
    expect(articleDocumentSchema.safeParse({ ...input, blocks: [{ type: 'paragraph', text: '正文', card: { kind: 'invented' } }] }).success).toBe(false);
  });

  it('uses uploaded image URLs and the same styled HTML for official drafts', () => {
    const document = articleDocumentSchema.parse({ ...input, blocks: [...input.blocks, { type: 'image', materialId: 'project-image', caption: '真实图注' }] });
    const options = { author: '', contentSourceUrl: '', openComments: false, onlyFansCanComment: false };
    const imageUrls = new Map([[7, 'https://mmbiz.qpic.cn/photo.png']]);
    const article = makeWechatArticle(document, options, 'cover-id', imageUrls);
    const resolved = { ...document, blocks: document.blocks.map((block) => block.type === 'image' ? { ...block, src: imageUrls.get(7) } : block) };
    expect(article.content).toBe(renderArticleDocument(resolved, 'wechat').html);
    expect(article.content).toContain('max-width:100%;height:auto;');
    expect(article.content).not.toMatch(/(?:style="|;)width:100%/);
    expect(() => verifyWechatDraft(article, [article])).not.toThrow();
    expect(() => verifyWechatDraft(article, [{ ...article, content: article.content.replace('真实图注', '错误图注') }])).toThrow('WECHAT_DRAFT_MISMATCH');
    expect(() => renderArticleDocument({ ...document, blocks: [{ type: 'image', src: 'javascript:alert(1)' }] }, 'wechat')).toThrow('ARTICLE_IMAGE_UNRESOLVED');
  });

  it('counts layout markup in the content size preflight', () => {
    const document = articleDocumentSchema.parse({ ...input, blocks: Array.from({ length: 80 }, () => ({ type: 'paragraph', text: '正文。', card: { kind: 'intro', label: '提示' } })) });
    expect(() => prepareDocument(document)).toThrow('WECHAT_CONTENT_TOO_LONG');
  });
});
