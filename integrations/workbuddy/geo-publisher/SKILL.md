---
name: geo-publisher
description: Use GEO Publisher Desktop and its local CLI to validate, fill, preview, or publish articles on Baijiahao, Toutiao, Zhihu, Tencent Content Open Platform, Sohu, and NetEase. Trigger whenever the user asks to log in to a supported platform, fill an article, inspect a draft, publish content, check publishing status, or diagnose the GEO Publisher connection.
---

# GEO Publisher

Use the desktop application as the execution engine and the current customer project's only content store. Do not use browser extensions, MCP publishers, fixed ports, screen coordinates, direct browser automation, or a separate customer workspace. `inspect`, `fill`, and `publish` run in GEO Publisher's background execution page and must not be preceded by `show` or `open`.

## Customer project context

Run `geo-publisher project current` before generating an article, filling a draft, or publishing. The returned `project` is the current customer project selected in GEO Publisher and is the source of company name, business profile, products, strengths, cases, credentials, customer questions and forbidden phrases.

When the user wants to create, complete, extract, polish, or update customer information, load and follow the sibling `geo-customer-profile` Skill. That Skill owns the short collection workflow and confirmation rules; this Skill owns CLI resolution and publishing behavior.

When the user asks for intent words, customer questions, a topic pool, or weekly topic planning, load the sibling `geo-topic-planner` Skill. When the user asks to write, revise, or quality-check an article, load the sibling `geo-article-writer` Skill. Those Skills own content creation; this Skill remains the only owner of platform login, validation, filling, publishing, and reconciliation.

When the user asks to organize images, or `material pending` returns new images before article work, load the sibling `geo-material-organizer` Skill. It owns one-time visual indexing and may only use the dedicated `material pending|get|analyze` commands.

- Never infer, cache, or substitute a customer project from another WorkBuddy task.
- Include the exact returned `project.id` as `projectId` in every `validate`, `fill`, and `publish` input.
- If no current project exists and the customer wants WorkBuddy to create one, collect the company profile interactively. Show the proposed project name and a concise profile summary, obtain explicit confirmation, then write a JSON file with `confirmCreate: true` and run `geo-publisher project create --input <file.json>`. Never create a project before that confirmation.
- A successful `project create` automatically selects the new project. Immediately run `project current` and verify that its `project.id` and name match the created project before saving content or publishing.
- Do not ask for every field at once. Collect the project name and basic company information first, then ask only for important missing facts. Never invent company facts.
- If a command returns `PROJECT_CONTEXT_CHANGED`, stop immediately, re-read `project current`, regenerate or reconfirm the content for that customer, and do not retry the old publish request.
- A customer may ask WorkBuddy to update company information. Summarize the proposed changes, obtain confirmation, then run `geo-publisher project update <projectId> --input <file.json>`.

Example confirmed project input:

```json
{
  "confirmCreate": true,
  "name": "客户项目名称",
  "companyName": "公司全称",
  "industry": "所属行业",
  "products": "核心产品或服务",
  "strengths": "核心优势"
}
```

## Content center

All materials, topics, article packages, and distribution records belong to the current desktop project. Never create a parallel worktree, company-information Markdown file, or template state as a source of truth.

- Use `geo-publisher content list <projectId> [material|topic|article|distribution]` to inspect existing project content before creating duplicates.
- Use `geo-publisher material pending|get|analyze` only through `geo-material-organizer` to index newly uploaded images once.
- Use `geo-publisher content save <projectId> --input <file.json>` to persist generated content. The JSON contains `kind`, `title`, optional `status`, optional `platform`, and `payload`.
- An article package uses `kind: "article"`; its `payload.document` must be the same structured document later passed to `validate`, `fill`, and `publish`.
- A topic uses `kind: "topic"`, a material index record uses `kind: "material"`, and a platform execution/reconciliation record uses `kind: "distribution"`.
- Before saving or distributing, re-read `project current` and stop if the returned `project.id` differs from the article package's `projectId`.

## Resolve the CLI

Run `geo-publisher doctor` when the command is available. Otherwise read `discovery.json` from the operating system's GEO Publisher user-data directory and invoke its `cliPath`:

- macOS: resolve from the current user's `~/Library/Application Support/GEO Publisher Desktop` directory.
- Windows: resolve from `%LOCALAPPDATA%\GEO Publisher Desktop`.

Never copy a path or user name from another computer. If discovery is missing, ask the user to install and open GEO Publisher Desktop once.

Treat the discovered `cliPath` as one executable path even when it contains spaces. On Windows PowerShell invoke it with the call operator, for example `& '<discovered cliPath>' doctor`; do not split or reconstruct the path. Use only the production `geo-publisher` binary supplied by the desktop. Never search for or invoke `geo-publisher-dev`, `.dev-cli`, raw control sockets, control tokens, or developer-only commands.

## Execute a request

1. Run `doctor`. If the desktop is not connected, run `start`, then `doctor` again.
2. Run `instructions --json` and follow the current desktop version's workflow.
3. Run `validate` with the article JSON before any browser operation.
4. For requests such as “看看效果”, “填充”, “预览”, or “不要发布”, run `fill` only.
5. Run `publish` only when the user explicitly asks for real publishing. Set `confirmPublish` to `true` in that request.
6. Process multiple platforms serially in this order unless the user specifies another order: `baijia`, `toutiao`, `zhihu`, `penguin`, `sohu`, `netease`.
7. Report the structured result for every platform.

## Build the article input

Run `geo-publisher schema --json` before assembling the first request in a task. The desktop version is authoritative for the exact input contract.

- Send one `document` object, not top-level `title`、`html` or `tags` fields.
- `document.title` is the published title. `document.blocks` must use semantic blocks: `paragraph`、`heading`（only level 2 or 3）、`list`、`quote`、`divider`、`image`.
- Keep text natural. Do not put raw Markdown markers (`##`、`-`、`>`) or raw HTML into block text.
- `document.summary` and `document.tags` are optional platform metadata. Tags are plain topic strings such as `#企业AI`.
- An `image` block needs a real http(s) URL. A local image path belongs only in `coverPath`.
- Do not rewrite an article to fit a platform after it has been produced. Let GEO Publisher render the same structured content for that platform and return a format-verification result.

Example input for `validate` or `fill`:

```json
{
  "projectId": "the exact id from geo-publisher project current",
  "platform": "zhihu",
  "document": {
    "title": "企业部署 AI 工具前，先把哪三类流程理清？",
    "blocks": [
      { "type": "paragraph", "text": "很多团队并不缺工具，缺的是先后顺序。" },
      { "type": "heading", "level": 2, "text": "先识别重复决策" },
      { "type": "list", "ordered": false, "items": ["收集需求", "整理资料"] },
      { "type": "quote", "text": "先明确边界，再讨论工具。" }
    ],
    "summary": "用三类流程判断 AI 工具的部署优先级。",
    "tags": ["#企业AI", "#流程优化", "#数字化"]
  },
  "coverPath": ""
}
```

## Interpret platform status correctly

- `created` means the platform page currently has an in-memory WebView. `created=false` does not mean logged out.
- `attached` means the platform page is currently visible in the GEO Publisher window. `runtimeState=background` means an automation page is retained without showing it. Neither state indicates whether the account is logged in.
- The desktop keeps the current interactive page and at most one background task page. Login cookies remain stored per platform.
- Never convert `created/attached` into a login table or label a platform as `待登录` from those fields.
- When the user asks whether platforms are logged in, run `inspect <platform>` serially for every requested platform. Report `已登录` only when the actual publishing page is visible, and report `待登录` only when the inspected page contains a visible login, verification, or risk-control prompt. Otherwise report `登录状态未确认`.

Use these platform mappings:

- 百家号: `baijia`
- 头条号/今日头条: `toutiao`
- 知乎: `zhihu`
- 企鹅号/腾讯内容开放平台: `penguin`
- 搜狐号: `sohu`
- 网易号: `netease`

## Handle failures

- For `LOGIN_REQUIRED`, `VERIFICATION_REQUIRED`, or `RISK_CONTROL_REQUIRED`, GEO Publisher has already opened the exact affected page. Ask the user to complete that visible action, then retry the same command once. Do not wait on the original command or issue `publish` again automatically.
- For quota exhaustion, stop that platform and report the platform message.
- For `result_uncertain`, query status or reconcile the management page. Never click publish again automatically.
- For `ZHIHU_FORMAT_DEGRADED` or `NETEASE_FORMAT_DEGRADED`, do not publish. The desktop has detected that the editor removed required article structure; preserve the complete error and ask for an adapter update.
- Never weaken required input validation to force a task through.
- Preserve complete JSON errors when asking WorkBuddy or technical support for help.
