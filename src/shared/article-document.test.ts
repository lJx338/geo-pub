import { describe, expect, it } from 'vitest';
import { articleDocumentSchema, normalizeArticleTags, renderArticleDocument } from './article-document.js';

describe('article document', () => {
  const document = {
    title: '企业部署 AI 工具前，先把哪三类流程理清？',
    blocks: [
      { type: 'paragraph' as const, text: '先把重复、高风险和需要跨部门协同的流程分开。' },
      { type: 'heading' as const, level: 2 as const, text: '先识别重复决策' },
      { type: 'list' as const, ordered: false, items: ['收集需求', '整理资料'] },
      { type: 'quote' as const, text: '先明确边界，再讨论工具。' },
    ],
    tags: ['企业AI', '流程梳理'],
  };

  it('accepts portable structured blocks', () => {
    expect(articleDocumentSchema.safeParse(document).success).toBe(true);
  });

  it('renders only a safe HTML subset and preserves block expectations', () => {
    const result = renderArticleDocument(articleDocumentSchema.parse(document));
    expect(result.html).toContain('<h2>先识别重复决策</h2>');
    expect(result.html).toContain('<ul><li>收集需求</li><li>整理资料</li></ul>');
    expect(result.structuralExpectations).toMatchObject({ headings: 1, lists: 1, quotes: 1 });
    expect(result.html.endsWith('<p>#企业AI #流程梳理</p>')).toBe(true);
    expect(result.text.endsWith('#企业AI #流程梳理')).toBe(true);
  });

  it('normalizes and deduplicates article topics before appending them', () => {
    const parsed = articleDocumentSchema.parse({
      ...document,
      tags: [' #企业AI ', '＃流程梳理＃', '企业ai', '落地方法', '成本评估', '团队协作', '额外话题'],
    });
    const result = renderArticleDocument(parsed);
    expect(normalizeArticleTags(parsed.tags)).toEqual(['企业AI', '流程梳理', '落地方法', '成本评估', '团队协作']);
    expect(result.html.endsWith('<p>#企业AI #流程梳理 #落地方法 #成本评估 #团队协作</p>')).toBe(true);
  });

  it('escapes topic text and omits the topic paragraph when no tags exist', () => {
    const escaped = renderArticleDocument(articleDocumentSchema.parse({ ...document, tags: ['AI<落地>'] }));
    expect(escaped.html.endsWith('<p>#AI&lt;落地&gt;</p>')).toBe(true);

    const empty = renderArticleDocument(articleDocumentSchema.parse({ ...document, tags: [] }));
    expect(empty.html).not.toContain('<p>#</p>');
    expect(empty.text).not.toContain('#');
  });

  it('escapes text instead of accepting raw HTML or Markdown as formatting', () => {
    const result = renderArticleDocument(articleDocumentSchema.parse({
      ...document,
      blocks: [{ type: 'paragraph', text: '<script>alert(1)</script> ## 不是小标题' }],
    }));
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; ## 不是小标题');
    expect(result.html).not.toContain('<script>');
  });

  it('uses a safe fallback for NetEase blocks its Draft.js editor flattens', () => {
    const result = renderArticleDocument(articleDocumentSchema.parse({
      ...document,
      blocks: [
        { type: 'heading', level: 2, text: '网易号小标题' },
        { type: 'divider' },
      ],
    }), 'netease');
    expect(result.html).toContain('<p><strong>网易号小标题</strong></p>');
    expect(result.html).not.toContain('<h2>');
    expect(result.html).not.toContain('<hr>');
    expect(result.structuralExpectations).toMatchObject({ headings: 0, dividers: 0 });
    expect(result.html.endsWith('<p>#企业AI #流程梳理</p>')).toBe(true);
  });

  it('rejects unsupported headings and local image paths', () => {
    expect(articleDocumentSchema.safeParse({ ...document, blocks: [{ type: 'heading', level: 1, text: '标题' }] }).success).toBe(false);
    expect(articleDocumentSchema.safeParse({ ...document, blocks: [{ type: 'image', src: '/tmp/image.png' }] }).success).toBe(false);
  });
});
