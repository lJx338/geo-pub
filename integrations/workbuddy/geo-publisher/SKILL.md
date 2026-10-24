---
name: geo-publisher
description: Use Lingxi Workspace and its local CLI to validate, fill, preview, or publish articles on Baijiahao, Toutiao, Zhihu, Tencent Content Open Platform, Sohu, NetEase, WeChat Official Account, and Lieju. Trigger whenever the user asks to log in to a supported platform, fill an article, inspect a draft, publish content, save a 公众号草稿, check publishing status, or diagnose the Lingxi Workspace connection.
---

# Lingxi Workspace

Use the desktop application as the execution engine and the current customer project's only content store. Do not use browser extensions, MCP publishers, fixed ports, screen coordinates, direct browser automation, or a separate customer workspace. Browser platform operations run in Lingxi Workspace's background execution page and must not be preceded by `show` or `open`. WeChat `fill` uses the desktop's official API adapter and needs no browser page or website login.

## Customer project context

For a customer-specific automation, run `geo-publisher project list`, find one exact project-name match, then run `geo-publisher project select <projectId>` and `geo-publisher project current`. Before generating an article, filling a draft, or publishing, verify that the returned current project ID and name still match the task. The returned `project` is the source of company name, business profile, products, strengths, cases, credentials, customer questions and forbidden phrases.

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

By default, omit `platformOptions` so the desktop uses the current customer's saved defaults. Only when the user explicitly asks to change this one Baijia article may you add a one-shot override:

```json
{
  "platformOptions": {
    "baijia": {
      "smartCreation": ["autoPodcast"],
      "declarations": ["aiGenerated", "source"],
      "sourceDate": "2026-08-20",
      "sourceLocation": "河北省 / 沧州市"
    }
  }
}
```

`smartCreation` may contain `autoPodcast` and `convertToDynamic`; `declarations` may contain `aiGenerated` and `source`. Both arrays may be empty, and both choices in a group may be selected together. Selecting `source` requires `sourceDate` in `YYYY-MM-DD` format and a `sourceLocation` path. Never infer an override from article content, never reuse it for another article, and never send DOM selectors or page scripts. Activity submission is not supported.

## Content center

All materials, topics, article packages, and distribution records belong to the current desktop project. Never create a parallel worktree, company-information Markdown file, or template state as a source of truth.

- Use `geo-publisher content list <projectId> [material|topic|article|distribution]` to inspect existing project content before creating duplicates.
- Use `geo-publisher material pending|get|analyze` only through `geo-material-organizer` to index newly uploaded images once.
- Use `geo-publisher content save <projectId> --input <file.json>` to persist generated content. The JSON contains `kind`, `title`, optional `status`, optional `platform`, and `payload`.
- An article package uses `kind: "article"`; its `payload.document` must be the same structured document later passed to `validate`, `fill`, and `publish`.
- A topic uses `kind: "topic"`, a material index record uses `kind: "material"`, and a platform execution/reconciliation record uses `kind: "distribution"`.
- Before saving or distributing, re-read `project current` and stop if the returned `project.id` differs from the article package's `projectId`.

## Resolve the CLI

If the user supplied the desktop's “连接 WorkBuddy” prompt, use its complete CLI call prefix for every command. For Mac App Store installations it includes `env GEO_PUBLISHER_USER_DATA_DIR=... /bin/sh ...`; preserve all of it. The app obtains the data directory from Electron's sandbox runtime. Never replace it with the non-store path below, and never run the embedded Go helper directly. The bundled client transfers input JSON and local cover/material files to the running app. Existing command names and JSON results stay the same. A connection failure does not authorize retrying a publish; inspect the platform state first.

For Microsoft Store (MSIX) installations, the desktop exports the actual redirected CLI and Skill paths. Its PowerShell call prefix also sets `$env:GEO_PUBLISHER_USER_DATA_DIR` to the actual data directory. Preserve that assignment for every command, including when falling back to `cmd.exe`; use the complete fallback command in the connection prompt. Do not replace these paths with `%LOCALAPPDATA%\GEO Publisher Desktop` or invoke only the EXE without the data-directory assignment.

Run `geo-publisher doctor` when the command is available. Otherwise read `discovery.json` from the operating system's Lingxi Workspace user-data directory and invoke its `cliPath`:

- macOS: resolve from the current user's `~/Library/Application Support/GEO Publisher Desktop` directory.
- Windows: resolve from `%LOCALAPPDATA%\GEO Publisher Desktop`.

Never copy a path or user name from another computer. If discovery is missing, ask the user to install and open Lingxi Workspace once.

Treat the discovered `cliPath` as one executable path even when it contains spaces. On Windows PowerShell invoke it with the call operator, for example `& '<discovered cliPath>' doctor`; do not split or reconstruct the path. Use only the production `geo-publisher` binary supplied by the desktop. Never search for or invoke `geo-publisher-dev`, `.dev-cli`, raw control sockets, control tokens, or developer-only commands.

On Windows, perform one connectivity check and require a JSON response before continuing: `& '<discovered cliPath>' doctor --json`. If the PowerShell tool returns only its own `powershell` path or no stdout, do not retry the same PowerShell command and do not conclude that the CLI is broken. Fall back once to `cmd.exe /d /s /c '"<discovered cliPath>" doctor --json'` or Git Bash with the same complete path, then verify the returned JSON contains `ok` or `command`. Capture stdout, stderr, and exit code for every command; never use `Start-Process` without redirected output.

## Execute a request

1. Run `doctor`. If the desktop is not connected, run `start`, then `doctor` again.
2. Run `instructions --json` and follow the current desktop version's workflow.
3. Run `validate` with the article JSON before any browser operation.
4. For requests such as “看看效果”, “填充”, “预览”, or “不要发布”, run `fill` only.
5. Run `publish` only when the user explicitly asks for real publishing. Set `confirmPublish` to `true` in that request. For `wechat`, always use `fill` to save a draft; formal publication and sending to followers are not supported. In a mixed authorized distribution task, publish only the requested supported platforms and report WeChat separately as a draft.
6. Process multiple platforms serially in this order unless the user specifies another order: `baijia`, `toutiao`, `zhihu`, `penguin`, `sohu`, `netease`, `wechat`, `lieju`. All platforms means these eight; an explicit subset still takes precedence.
7. Report the structured result for every platform.

## Build the article input

Run `geo-publisher schema --json` before assembling the first request in a task. The desktop version is authoritative for the exact input contract.

- Send one `document` object, not top-level `title`、`html` or `tags` fields.
- `document.title` is the published title. `document.blocks` must use semantic blocks: `paragraph`、`heading`（only level 2 or 3）、`list`、`quote`、`divider`、`image`.
- Keep text natural. Do not put raw Markdown markers (`##`、`-`、`>`) or raw HTML into block text.
- `document.summary` is optional platform metadata. Every ready article must provide two to five concise, article-specific topics or keywords in `document.tags`, such as `企业AI` and `流程优化`; omit a leading `#`. Lingxi Workspace appends them to the article ending and also fills a platform-native topic field when supported.
- An `image` block should use a `materialId` from the current project's indexed material library; `alt` and `caption` are optional. Other platforms may also use a real http(s) `src`, but WeChat requires material IDs. A local file path belongs only in `coverPath`, not in body text or `src`.
- Select the saved article whose `platform` matches the destination and whose `payload.topicId` matches the requested topic. Use that package's exact `payload.document`; do not send one platform's body to every destination or rewrite it during distribution. If a platform package is missing, route writing to `geo-article-writer` before distribution. An explicit user request to distribute one existing article unchanged may still use that article.

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
    "tags": ["企业AI", "流程优化", "数字化"]
  },
  "coverPath": ""
}
```

## Interpret platform status correctly

These browser-status checks apply to website sessions. For WeChat API readiness, follow the WeChat section below; `login wechat` and `inspect wechat` inspect only the embedded website and do not establish API permissions.

- `created` means the platform page currently has an in-memory WebView. `created=false` does not mean logged out.
- `attached` means the platform page is currently visible in the Lingxi Workspace window. `runtimeState=background` means an automation page is retained without showing it. Neither state indicates whether the account is logged in.
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
- 微信公众号/公众号: `wechat`

## WeChat official-account drafts

- The user connects their own account in GEO Publisher: 平台账号 → 微信公众号 → 连接设置 → 保存并测试连接. Credentials stay encrypted on that customer's computer. Do not ask for AppSecret in chat, article JSON, CLI arguments, or a separate configuration file. Browser scanning and API credentials are separate.
- Writing and saving a local `wechat` article does not need credentials. Missing credentials block remote draft saving only. If the API reports missing credentials, permissions or IP whitelist issues, direct the user to the desktop connection settings and preserve the exact error; do not fall back to automating the website editor.
- Read the saved `wechat` package, run `validate`, then `fill` only when draft saving/distribution was requested. `validate` checks local input and does not prove live API access. Use a title of 2-32 characters, a local PNG/JPEG cover under 10 MB, and PNG/JPEG body material images under 1 MB each. Network images must first be imported into the current project.
- Normally omit `platformOptions`. If explicitly requested for this one draft, `platformOptions.wechat` may contain `title` and `author`; `expectedAppId` may bind a known target account. Never invent an author or account ID. AppID/AppSecret configuration happens in desktop settings, not here.
- Report `草稿已保存` only when `status=filled`, `saved=true`, `verified=true`, and `mediaId` is present. Report the draft ID; the returned management URL is not a published article link. Keep the source article locally `ready`, not `published`.
- If the result is `action_required`, keep the draft ID and ask the user to use the original distribution record's `重新核对` action. If `result_uncertain` or a control timeout occurs, inspect saved distribution records and ask for reconciliation in the account backend; never automatically resubmit, publish, or send to followers.

## Handle failures

- For `LOGIN_REQUIRED`, `VERIFICATION_REQUIRED`, or `RISK_CONTROL_REQUIRED`, Lingxi Workspace has already opened the exact affected page. Ask the user to complete that visible action, then retry the same command once. Do not wait on the original command or issue `publish` again automatically.
- For quota exhaustion, stop that platform and report the platform message.
- For `result_uncertain`, query status or reconcile the management page. Never click publish again automatically.
- For `ZHIHU_FORMAT_DEGRADED` or `NETEASE_FORMAT_DEGRADED`, do not publish. The desktop has detected that the editor removed required article structure; preserve the complete error and ask for an adapter update.
- Never weaken required input validation to force a task through.
- Preserve complete JSON errors when asking WorkBuddy or technical support for help.

## Lieju manual submission

- `lieju` is part of all eight platforms. Always use `fill`, even in an authorized all-platform publishing request. `publish` is unsupported.
- Read current-project `publishingDefaults.lieju`; direct users to Platform Accounts → Lieju settings if city/category/contact fields are missing. Never guess category IDs. Default price is the user-configured string `1`, not AI-generated pricing.
- Filling writes the title and plain-text body, configured required fields and image attachments, then requests the captcha. A successful handoff returns `pending_manual`: report “已填充，待手动发布”. The USER completes the slider, checks the content and submits. Do not solve captcha, click submit, continue automatically after verification, or report publication success.
- A pending page stays open during other platform tasks. Never refill it automatically; ask the user to finish or explicitly discard it by refreshing.
- Use current-project material IDs for body images. The adapter converts images to JPEG under 1 MB. The optional cover is uploaded as another attachment.
