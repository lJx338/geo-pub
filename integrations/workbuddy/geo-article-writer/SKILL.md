---
name: geo-article-writer
description: Write, revise, quality-check, and save structured GEO article packages for the current GEO Publisher customer project. Use when the user asks for 生成文章、写文章、今日内容、根据选题写作、六平台文章, to turn a saved topic into content, create articles for one or more supported platforms, or revise an existing article package. Selects among E-E-A-T, question, case, pitfall, recommendation, operation, seven-dimension, and B2B four-step structures. Do not use for browser filling or publishing.
---

# GEO Article Writer

Generate content inside the current GEO Publisher project. Never depend on the retired template workspace, `.geo-system`, CSV schedules, or company-information Markdown files.

## Start

1. Resolve the production CLI through the sibling `geo-publisher` Skill.
2. Run `doctor`, `instructions --json`, and `project current`.
3. Record the exact current project and read its company facts.
4. Run `material pending <projectId> --limit 20`. If it returns images, load the sibling `geo-material-organizer` Skill and finish the one-time indexing before selecting images. Then run `content list <projectId> material --query <keywords>`, `content list <projectId> topic --auto-selectable`, and `content list <projectId> article`. Do not rescan analyzed original files. An already-used evergreen topic is not directly selectable: ask the topic planner to create an approved variant first.
5. Select one available topic. If the user supplied a title directly, create and save a topic through the sibling `geo-topic-planner` rules before writing.
6. Generate a unique task ID and run `topic reserve <projectId> --topic <topicId> --task <taskId>` before writing. If reservation fails, select another available topic; never bypass the reservation.
7. Read [output-contract.md](references/output-contract.md) completely.
8. Read exactly one matching structure file from `references/structures/`.
9. Read [platform-rules.md](references/platform-rules.md) for every requested platform.

Re-run `project current` before every save. Stop with `PROJECT_CONTEXT_CHANGED` if it differs from the article's project ID.

## Choose platforms

- Honor explicitly named platforms.
- “六个平台” means `baijia`, `toutiao`, `zhihu`, `penguin`, `sohu`, and `netease`.
- For an existing scheduled topic that already names platforms, follow that schedule.
- If neither the user nor the selected topic names a platform, generate one project-level preview article and ask which platforms to prepare; do not guess and create six packages silently.

When generating multiple platforms, create each article independently from the selected topic and evidence. Do not write one mother draft and mechanically rewrite it six times. The locked core question and direct answer remain consistent, but opening, evidence order, examples, pacing, and section structure should fit the platform.

## Route the structure

Use the topic's approved `articleType`. If a manual title has no type, infer it once and save it on the topic before writing.

| Type | Reference |
|---|---|
| `eeat` | [eeat.md](references/structures/eeat.md) |
| `question` | [question.md](references/structures/question.md) |
| `case` | [case.md](references/structures/case.md) |
| `pitfall` | [pitfall.md](references/structures/pitfall.md) |
| `recommendation` | [recommendation.md](references/structures/recommendation.md) |
| `operation` | [operation.md](references/structures/operation.md) |
| `seven_dimension` | [seven-dimension.md](references/structures/seven-dimension.md) |
| `b2b_four_step` | [b2b-four-step.md](references/structures/b2b-four-step.md) |

Do not load all structure files. Only load the selected structure to reduce routing mistakes.

## Save an article package

Save one content item per platform. A project-level preview may use an empty platform string.

```json
{
  "kind": "article",
  "title": "锁定的选题标题",
  "status": "ready",
  "platform": "zhihu",
  "payload": {
    "articleVersion": 1,
    "topicId": "saved topic id",
    "articleType": "question",
    "coreQuestion": "唯一核心问题",
    "directAnswer": "一句直接答案",
    "documentVersion": 1,
    "document": {
      "title": "可直接发布的标题",
      "blocks": [],
      "summary": "不超过120字的摘要",
      "tags": ["#真实话题一", "#真实话题二", "#真实话题三"]
    },
    "quality": { "score": 26, "passed": true, "notes": [] }
  }
}
```

Write it through `content save <projectId> --input <article.json>`. Do not mark an article `ready` until the output contract passes. Updating an existing article must retain its content item `id`, so a revision replaces the package instead of creating an ambiguous duplicate.

After every requested article package has been saved successfully, run `topic use <projectId> --topic <topicId> --article <articleId> --task <taskId>`. If generation or saving fails, run `topic release <projectId> --topic <topicId> --task <taskId>` before reporting the error. Never leave a topic reserved after a failed task.

## Boundaries

- Do not call `fill` or `publish`; hand ready packages to the sibling `geo-publisher` Skill.
- Do not insert Markdown markers or HTML into block text.
- Do not expose quality scores, evidence notes, prompts, missing-data notes, cover instructions, or platform operations inside published body blocks.
- Never invent company facts, named customers, completed project results, credentials, rankings, policies, or external statistics. You may create clearly framed common scenarios, professional reasoning, checklists, and hypothetical examples.
- Do not alter an approved topic into an abstract headline during writing.
