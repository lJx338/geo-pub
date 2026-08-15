# Article Output Contract

## Voice and facts

- Write as the company's official account in a restrained near-first-person voice.
- Use the full company or brand name naturally two to four times; E-E-A-T articles may use it three to four times.
- Link the company to confirmed products, audiences, scenarios, strengths, cases, or credentials.
- Never invent company facts, named customers, results, credentials, rankings, prices, policies, or external data.
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
- Finish with a natural next action and three to five specific topic tags, without hard selling.

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
  "tags": ["#真实话题一", "#真实话题二", "#真实话题三"]
}
```

Allow only `paragraph`, `heading` level 2 or 3, `list`, `quote`, `divider`, and `image`. An image needs a real HTTP(S) URL. Never place raw Markdown or HTML inside block text.

## Quality gate

Score 0-5 on each dimension: intent coverage, scenario match, structure and logic, keyword coverage, verifiability and citation value, and natural language. A total of 25-30 passes; 20-24 requires revision; below 20 must not become `ready`.

Before saving `ready`, verify that there is no placeholder, prompt residue, internal note, or generic template heading; the title and opening answer the locked question; three to five real tags exist; company facts are accurate; the schema is valid; and no existing platform article duplicates this topic.
