---
name: geo-customer-profile
description: Collect, extract, lightly polish, confirm, create, or update customer company profiles in GEO Publisher Desktop. Use when a customer asks to create a customer project, configure or complete company information, update an existing profile, or provides a company introduction, brand profile, brochure, or website copy specifically to initialize or improve the desktop customer project.
---

# GEO Customer Profile

Keep GEO Publisher Desktop as the only source of truth. Store the result through its production CLI; never create a separate workspace, Markdown profile, template state, or local customer database.

## Start

1. Resolve the production CLI using the sibling `geo-publisher` Skill. Never use developer commands, sockets, tokens, MCP publishers, or fixed paths.
2. Run `doctor`; run `start` only if the desktop is not connected.
3. Run `instructions --json`, then `project current`.
4. Determine whether the user wants a new project or an update to the current project. Never replace or merge another customer's project implicitly.

## Keep the conversation short

Use at most two collection rounds before the final confirmation unless the user asks to provide more detail.

### If the user has an introduction

Ask them to send any existing company introduction, brand profile, brochure copy, website introduction, product description, or sales material. A rough paragraph is enough.

After receiving it:

1. Extract every supported field that is directly supported by the text.
2. Lightly polish for clarity, remove repetition, and classify facts into the correct fields.
3. Show one compact summary titled “我整理出的客户资料”.
4. Ask one combined follow-up containing only critical missing or ambiguous facts. Skip optional fields the user may not know.
5. Do not save or create anything until the user confirms the complete summary.

### If the user has no introduction

First collection round, ask only:

- 项目名称
- 公司或品牌名称
- 所属行业
- 核心产品或服务
- 最突出的 1–3 个优势

Second collection round is optional. Ask in one message whether they want to add any operating years, representative cases, credentials, target customers, service areas, website/contact details, customer questions, allowed sources, or forbidden phrases. They may reply “暂时没有” and continue.

Then show the complete summary and ask for one explicit confirmation.

## Map information to GEO Publisher

Use only these project fields:

| Field | Meaning |
|---|---|
| `name` | Customer project name shown in the desktop |
| `companyName` | Company or brand name only |
| `operatingYears` | Founding time or operating years |
| `industry` | Industry, business category, or primary application field |
| `products` | Core products, services, or solutions |
| `strengths` | Differentiators, capabilities, delivery strengths, or product highlights |
| `cases` | Real representative customers, projects, results, or permitted anonymous cases |
| `credentials` | Certifications, patents, licenses, awards, standards, or authoritative endorsements |
| `valueAndAudience` | Target customers, their needs, and the value provided |
| `website` | Official website or approved public page |
| `contact` | Approved public contact or call to action |
| `serviceArea` | Regions, industries, or application scenarios served |
| `allowedSources` | Sources WorkBuddy may quote or use |
| `forbiddenPhrases` | Claims, sensitive wording, competitors, or topics that must not appear |
| `customerQuestions` | Real sales questions, search phrases, objections, or common misunderstandings |
| `accountNotes` | Platform-specific account notes only |

Do not invent a value merely to fill a field. Optional fields may remain empty.

## Extraction and polishing rules

- Separate facts from slogans. Convert “行业领先、品质卓越” into a neutral expression only when the source provides concrete support; otherwise omit it.
- Preserve names, dates, quantities, certifications, customer names, results, regions, and contact details exactly. Never strengthen or fabricate them.
- Rewrite fragmented or repetitive text into reusable, concise project fields without changing meaning.
- Put each fact in one best field. Do not duplicate one sentence across several fields.
- Keep `companyName` to the name itself.
- Summarize long product lists into core categories and retain a few representative items.
- Treat inferred information as “待确认”, not as fact. Example: a product may suggest an industry, but the industry still needs confirmation if not stated.
- Remove personal phone numbers, private WeChat IDs, ID numbers, passwords, cookies, and other secrets unless the user explicitly confirms that a contact is intended for public publication.
- Do not turn this task into article writing. A polished company introduction is a profile summary, not promotional copy.

## Confirmation

Before creating or updating, show:

1. Project name.
2. The non-empty project fields in plain Chinese.
3. Any inferred or uncertain statements under “待确认”.
4. A direct question: “以上资料是否确认写入 GEO Publisher？回复‘确认创建’或告诉我需要修改的地方。”

Only an explicit confirmation in the current conversation authorizes the write. Do not treat silence, “差不多”, or a previous unrelated confirmation as authorization.

## Create a project

After explicit confirmation, write a temporary JSON object containing the confirmed fields and `confirmCreate: true`, then run:

```text
geo-publisher project create --input <project.json>
```

Do not include unknown fields. Delete the temporary file after the command finishes. Run `project current` immediately and verify the returned project ID and name. If they differ, stop with `PROJECT_CONTEXT_CHANGED` and do not save content or publish.

## Update the current project

For updates, summarize only the fields that will change and obtain explicit confirmation. Then run:

```text
geo-publisher project update <currentProjectId> --input <changes.json>
```

Run `project current` again and verify the values. Never use an ID cached from another conversation.

## Completion

Report the saved project name and the important non-empty fields. Clearly list optional information that remains empty, but do not force the user to complete it before generating content. Do not claim completion unless the CLI write and the final `project current` verification both succeed.
