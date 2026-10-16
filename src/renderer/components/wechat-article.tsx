import React, { useEffect, useState } from 'react';
import { articleDocumentSchema, renderArticleDocument, type ArticleBlock } from '../../shared/article-document.js';
import { wechatLayoutSchema, wechatThemes, type WechatLayout } from '../../shared/wechat-layout.js';

/** Uses exactly the renderer used by the draft adapter, with local thumbnails. */
export function WechatArticlePreview({ projectId, document }: { projectId: string; document: unknown }) {
  const [preview, setPreview] = useState<{ source: unknown; projectId: string; html?: string; error?: string }>();
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const parsed = articleDocumentSchema.parse(document);
        const blocks = await Promise.all(parsed.blocks.map(async (block) => block.type === 'image' && block.materialId
          ? { ...block, src: (await window.geoPublisher.materialThumbnail(projectId, block.materialId)).dataUrl } : block));
        const html = renderArticleDocument({ ...parsed, blocks }, 'wechat').html;
        if (active) setPreview({ source: document, projectId, html });
      } catch {
        if (active) setPreview({ source: document, projectId, error: '排版预览暂时无法显示，请检查文章格式和本项目图片素材。' });
      }
    })();
    return () => { active = false; };
  }, [projectId, document]);
  if (preview?.source !== document || preview.projectId !== projectId) return <p role="status">正在加载公众号排版…</p>;
  if (preview.error) return <p role="alert">{preview.error}</p>;
  // HTML is generated from validated fields by our escaping renderer; incoming
  // article text is never treated as markup. No external CSS is required.
  return <div className="wechat-layout-preview" dangerouslySetInnerHTML={{ __html: preview.html ?? '' }}/>;
}

export function WechatLayoutControls({ value, onChange }: { value?: WechatLayout; onChange: (value?: WechatLayout) => void }) {
  return <fieldset className="wechat-layout-controls"><legend>公众号排版</legend>
    <label>配色风格<select aria-label="公众号配色风格" value={value?.theme ?? ''} onChange={(event) => onChange(event.target.value ? wechatLayoutSchema.parse({ ...value, theme: event.target.value }) : undefined)}>
      <option value="">基础排版</option>{Object.entries(wechatThemes).map(([id, theme]) => <option key={id} value={id}>{theme.name}</option>)}
    </select></label>
    {value && <>
      <label>正文字号<select aria-label="公众号正文字号" value={value.fontSize} onChange={(event) => onChange({ ...value, fontSize: Number(event.target.value) })}>{[15, 16, 17, 18].map((size) => <option key={size} value={size}>{size} px</option>)}</select></label>
      <label>行距<input aria-label="公众号行距" type="number" min={1.6} max={2.2} step={0.1} value={value.lineHeight} onChange={(event) => onChange({ ...value, lineHeight: Number(event.target.value) })}/></label>
      <label>段落间距<input aria-label="公众号段落间距" type="number" min={12} max={32} value={value.paragraphSpacing} onChange={(event) => onChange({ ...value, paragraphSpacing: Number(event.target.value) })}/></label>
      <label>开篇小标签<input aria-label="公众号开篇小标签" maxLength={32} value={value.eyebrow ?? ''} placeholder="可选，例如：采购观察" onChange={(event) => onChange({ ...value, eyebrow: event.target.value })}/></label>
      <label className="article-inline-check"><input type="checkbox" checked={value.header} onChange={(event) => onChange({ ...value, header: event.target.checked })}/>显示开篇标题卡</label>
    </>}
    <p>选定风格后，小标题、引用和图片会统一排版。正文卡片与重点文字可在下方段落中调整。</p>
  </fieldset>;
}

type TextBlock = Extract<ArticleBlock, { type: 'paragraph' | 'quote' }>;
export function WechatBlockControls({ block, onChange }: { block: TextBlock; onChange: (block: TextBlock) => void }) {
  return <details className="wechat-block-controls"><summary>卡片与重点文字</summary>
    <label>段落样式<select aria-label="段落卡片样式" value={block.card?.kind ?? ''} onChange={(event) => onChange({ ...block, card: event.target.value ? { ...block.card, kind: event.target.value as NonNullable<TextBlock['card']>['kind'] } : undefined })}>
      <option value="">{block.type === 'quote' ? '默认引用' : '普通正文'}</option><option value="intro">导读卡片</option><option value="note">提示卡片</option><option value="takeaway">结论卡片</option>
    </select></label>
    {block.card && <label>卡片小标签<input aria-label="卡片小标签" maxLength={32} value={block.card.label ?? ''} onChange={(event) => onChange({ ...block, card: { ...block.card!, label: event.target.value } })}/></label>}
    {([['bold', '加粗短语'], ['underline', '下划线短语'], ['highlight', '高亮短语']] as const).map(([style, label]) => <label key={`${style}-${JSON.stringify(block.emphasis)}`}>{label}<input aria-label={label} defaultValue={block.emphasis?.filter((mark) => mark.style === style).map((mark) => mark.text).join('，') ?? ''} placeholder="填写本段原文中的短语，用逗号分隔" onBlur={(event) => onChange({ ...block, emphasis: [...(block.emphasis ?? []).filter((mark) => mark.style !== style), ...event.target.value.split(/[,，]/).map((text) => text.trim()).filter(Boolean).map((text) => ({ text, style }))] })}/></label>)}
  </details>;
}
