---
name: geo-publisher
description: Use GEO Publisher Desktop and its local CLI to validate, fill, preview, or publish articles on Baijiahao, Toutiao, Zhihu, Tencent Content Open Platform, Sohu, and NetEase. Trigger whenever the user asks to log in to a supported platform, fill an article, inspect a draft, publish content, check publishing status, or diagnose the GEO Publisher connection.
---

# GEO Publisher

Use the desktop application as the execution engine. Do not use browser extensions, MCP publishers, fixed ports, screen coordinates, or direct browser automation.

## Resolve the CLI

Run `geo-publisher doctor` when the command is available. Otherwise read `discovery.json` from the operating system's GEO Publisher user-data directory and invoke its `cliPath`:

- macOS: resolve from the current user's `~/Library/Application Support/GEO Publisher Desktop` directory.
- Windows: resolve from `%LOCALAPPDATA%\GEO Publisher Desktop`.

Never copy a path or user name from another computer. If discovery is missing, ask the user to install and open GEO Publisher Desktop once.

## Execute a request

1. Run `doctor`. If the desktop is not connected, run `start`, then `doctor` again.
2. Run `instructions --json` and follow the current desktop version's workflow.
3. Run `validate` with the article JSON before any browser operation.
4. For requests such as “看看效果”, “填充”, “预览”, or “不要发布”, run `fill` only.
5. Run `publish` only when the user explicitly asks for real publishing. Set `confirmPublish` to `true` in that request.
6. Process multiple platforms serially in this order unless the user specifies another order: `baijia`, `toutiao`, `zhihu`, `penguin`, `sohu`, `netease`.
7. Report the structured result for every platform.

Use these platform mappings:

- 百家号: `baijia`
- 头条号/今日头条: `toutiao`
- 知乎: `zhihu`
- 企鹅号/腾讯内容开放平台: `penguin`
- 搜狐号: `sohu`
- 网易号: `netease`

## Handle failures

- For login, captcha, or risk-control errors, ask the user to complete the visible action in GEO Publisher, then retry once.
- For quota exhaustion, stop that platform and report the platform message.
- For `result_uncertain`, query status or reconcile the management page. Never click publish again automatically.
- Never weaken required input validation to force a task through.
- Preserve complete JSON errors when asking WorkBuddy or technical support for help.
