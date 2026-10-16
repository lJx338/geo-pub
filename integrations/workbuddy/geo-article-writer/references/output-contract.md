# Article Output Contract

## Voice and facts

- Write as the company's official account in a restrained near-first-person voice.
- Use the full company or brand name naturally two to four times; E-E-A-T articles may use it three to four times.
- Link the company to confirmed products, audiences, scenarios, strengths, cases, or credentials.
- Never invent company facts, named customers, results, credentials, rankings, prices, policies, or external data.
- Never include website URLs, phone numbers, email addresses, WeChat IDs, QR-code instructions, or other contact and traffic-diversion details.
- You may add common scenarios, professional reasoning, checklists, and explicitly hypothetical examples.

## Title and opening

- Preserve the approved topic title. Shorten it only for a platform's hard title limit.
- Keep one core question. Do not add subtitles such as “完整指南、一文说清、快速判断、四个维度”.
- Enter a concrete customer situation within 100-150 Chinese characters.
- Give a quotable direct answer, condition, and reason within the first two paragraphs.
- Avoid “随着时代发展、在当今社会、综上所述、毋庸置疑、首先/其次/最后”.

## Body quality

- Cover three to five natural follow-up concerns that support the same core question.
- Provide at least two of: concrete actions, criteria, causal mechanisms, scenarios, examples, boundaries, or reusable checklists.
- Write headings for this exact topic. Never output generic headings such as “核心判断、常见误区、适合谁/不适合谁、总结与行动建议、边界与结论”.
- Remove structural prefixes such as “先说结论：” when the remaining heading or paragraph already carries the meaning.
- Finish the body with a natural next action, without hard selling. Separately provide two to five specific industry topics in `document.tags`; GEO Publisher renders them at the article ending.

## Structured document

The only publishing source is `payload.document`:

```json
{
  "title": "文章标题",
  "blocks": [
    { "type": "paragraph", "text": "正文" },
    { "type": "heading", "level": 2, "text": "针对本题的小标题" },
    { "type": "list", "ordered": false, "items": ["具体动作一", "具体动作二"] },
    { "type": "quote", "text": "需要强调的判断" },
    { "type": "divider" }
  ],
  "summary": "不超过120字",
  "tags": ["真实话题一", "真实话题二", "真实话题三"]
}
```

`tags` is required for every ready article. Use two to five concise topics or keywords that directly match the article, ideally two to eight Chinese characters each. Do not add `#` or `＃`, punctuation, contact details, broad filler such as “行业资讯”, or duplicate variants. GEO Publisher normalizes the values, adds the hash marks in the article-ending topic line, and also sends the same values to a platform-native topic field when supported.

Allow only `paragraph`, `heading` level 2 or 3, `list`, `quote`, `divider`, and `image`. Prefer an image from the current project's indexed material library: `{ "type": "image", "materialId": "saved material id", "alt": "图片描述", "caption": "图注" }`. Other platforms may also use a real HTTP(S) `src`; WeChat requires a current-project `materialId`, so import network images before use. Never invent an ID or reuse another customer's material. Never place raw Markdown or HTML inside block text.

For `wechat`, use the optional `document.wechatLayout` and the `card` / `emphasis` fields on paragraph and quote blocks defined in [wechat-layout.md](wechat-layout.md). These are presentation metadata on the same document, not a new article type or a second HTML source. Other platforms retain the basic contract above. Do not invent CSS, HTML, `style`, `html`, nested card blocks, or additional block types. Existing articles without `wechatLayout` remain valid and use basic formatting.

## Quality gate

Score 0-5 on each dimension: intent coverage, scenario match, structure and logic, keyword coverage, verifiability and citation value, and natural language. A total of 25-30 passes; 20-24 requires revision; below 20 must not become `ready`.

Before saving `ready`, verify that there is no placeholder, prompt residue, internal note, or generic template heading; the title and opening answer the locked question; two to five real article-specific tags exist; company facts are accurate; the schema is valid; and no existing article duplicates the same project/topic/platform combination. Different platforms should share the topic ID while having independently written bodies. On retry or revision update the matching article ID rather than saving a duplicate.
