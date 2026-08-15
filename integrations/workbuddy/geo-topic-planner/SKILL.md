---
name: geo-topic-planner
description: Generate, improve, deduplicate, schedule, or save GEO content topics for the current GEO Publisher customer project. Use when the user asks for 意图词、客户问题、生成选题、选题池、本周选题、内容规划, topic ideas, weekly topics, or wants to turn company materials and customer concerns into concrete article titles. Do not use for writing full articles or publishing them.
---

# GEO Topic Planner

Use GEO Publisher Desktop as the only source of truth. Never create a separate workspace, topic CSV, company-information file, or template state.

## Start

1. Resolve the production CLI through the sibling `geo-publisher` Skill.
2. Run `doctor`, `instructions --json`, and `project current`.
3. Stop and ask the user to select or create a customer project if no current project exists.
4. Record the exact `project.id`. Use it for every content command in this task.
5. Run `content list <projectId> material`, `content list <projectId> topic`, and `content list <projectId> article` before generating topics. Use `--query` to retrieve relevant indexed material instead of repeatedly loading every source file.
6. Read [topic-rules.md](references/topic-rules.md) completely before generating or revising topics.

Re-run `project current` immediately before saving. If the project changed, stop with `PROJECT_CONTEXT_CHANGED`; never save the old customer's topics into the new project.

## Decide the amount

- Honor an explicit number from the user.
- “本周选题” means the next seven days, five primary topics per day, 35 in total.
- A request that only says “生成一些选题” means five primary topics.
- Do not silently create six platform copies in the topic pool. One primary topic can later produce separate platform article packages.

## Build topics

Prioritize, in order:

1. `customerQuestions` and real user wording in the current project.
2. Current project materials, products, cases, target customers, service areas, and strengths.
3. Concrete questions inferred from the customer's product, audience, scenario, and decision stage.

Each topic must contain one customer question and one answer target. Never join two questions into one title. Treat article types as answer structures, not as title templates.

Route each topic to exactly one `articleType`: `eeat`, `question`, `case`, `pitfall`, `recommendation`, `operation`, `seven_dimension`, or `b2b_four_step`.

Use `case` only when the current project contains a real usable case. Otherwise route the topic to `question`.

## Show and save

For an interactive request, show a compact numbered preview containing title, target audience or scenario, direct answer, and article type. Let the user revise or reject items before saving when they ask to review first. For an explicitly automated or scheduled task, save topics that pass all checks without an extra confirmation.

Save each accepted topic separately with:

```json
{
  "kind": "topic",
  "title": "客户会直接提出的单一问题",
  "status": "approved",
  "reusePolicy": "standard",
  "payload": {
    "topicVersion": 1,
    "questionSource": "真实原话或推导依据",
    "questionCategory": "technical|science|teaching|selection|pitfall|case",
    "audience": "目标客户",
    "scenario": "具体发生场景",
    "concreteObject": "具体产品、服务或动作",
    "coreQuestion": "唯一核心问题",
    "directAnswer": "一句可独立引用的回答",
    "articleType": "question",
    "materialIds": [],
    "plannedDate": "可选的 YYYY-MM-DD"
  }
}
```

Write the JSON to a temporary file and run `geo-publisher content save <projectId> --input <topic.json>`. Delete temporary files after use. Report the saved count and titles only after every CLI write succeeds.

## Reuse a subject safely

- A normal topic remains in history after article generation but is excluded from automatic selection.
- If the user wants to keep writing about the same subject, find it with `content list <projectId> topic --reuse-policy evergreen` and create a linked angle variant with `topic variant <projectId> --topic <parentTopicId> --input <topic.json>`.
- Every variant must change the single customer question, title, scenario or decision angle. Never copy the original title or body.
- Use `reusePolicy: "evergreen"` only for a subject the user explicitly wants to develop continuously. Do not mark every generated topic evergreen.

## Boundaries

- Do not write full articles; use the sibling `geo-article-writer` Skill for that.
- Do not fill or publish platform pages; use the sibling `geo-publisher` Skill for that.
- Do not invent company credentials, customers, results, rankings, prices, or statistics.
- Do not save vague themes such as “行业趋势”, “深度解析”, “应用价值”, or “赋能未来” unless the title still contains a concrete customer question.
- Do not regenerate an approved topic during article writing unless the user explicitly requests a topic revision.
