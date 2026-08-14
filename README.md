# GEO Publisher Desktop

GEO Publisher 是独立的桌面发布器。它使用 Electron 内置浏览器保存六个平台的登录状态，通过本地 Go CLI 接收 WorkBuddy 或其他 Agent 的发布任务，不依赖 MCP、Chrome 扩展、Native Host 或固定端口。

## 许可证

本项目采用 [GNU Affero General Public License v3.0 or later](LICENSE)（`AGPL-3.0-or-later`）。使用、修改或分发本项目时应遵守该许可证；若向用户提供基于本项目修改后的网络服务，也必须向这些用户提供对应的完整源代码。

## 用户流程

1. 安装并打开 GEO Publisher；关闭主窗口后应用会驻留在系统托盘或 macOS 菜单栏。
2. 从左侧依次打开需要的平台并登录。
3. 点击“连接 WorkBuddy”，在 WorkBuddy 中粘贴已复制的连接指令。
4. 直接告诉 WorkBuddy 要填充或发布的文章和平台。自动任务在后台执行，不会抢占你正在使用的其他应用。

桌面端会根据当前系统动态安装 CLI 并生成发现文件，不包含开发机用户名或固定用户路径。Windows 上 CLI 按应用版本并存安装，正在执行旧任务时也不会阻止桌面端升级。登录失效、验证码或平台风控会作为结构化错误返回给 WorkBuddy，并在桌面端保留“需要人工处理”状态；自动任务不会主动打开或聚焦任何页面，用户需要时再手动打开对应平台处理。

## 支持平台

- 百家号 `baijia`
- 头条号 `toutiao`
- 知乎 `zhihu`
- 企鹅号 `penguin`
- 搜狐号 `sohu`
- 网易号 `netease`

## CLI

正式安装后，WorkBuddy 通过桌面端生成的 `discovery.json` 获取当前 CLI 路径。CLI 所有输出均为结构化 JSON。

```bash
geo-publisher doctor
geo-publisher instructions --json
geo-publisher schema --json
geo-publisher platforms
geo-publisher validate --input article.json
geo-publisher fill --input article.json
geo-publisher publish --input article.json
```

真实发布必须在 JSON 中显式设置 `"confirmPublish": true`。当结果为 `result_uncertain` 时禁止自动重发，应先在管理页对账。

文章输入使用结构化 `document`：标题、段落、小标题、列表、引用、分隔线和正文图片分别作为独立内容块传入。桌面端会按平台编辑器写入并回读结构；若页面把要求的小标题、列表、引用、分隔线或正文图片降级为纯文本，会停止发布并返回 `*_FORMAT_DEGRADED`，避免格式混乱的文章进入平台。

## 开发

```bash
npm install
npm run dev
npm run verify
```

Windows x64 打包：

```bash
npm run package:win
```

macOS 仅支持 Apple Silicon（M1/M2/M3/M4），不提供 Intel Mac 版本：

```bash
npm run package:mac
```

## 自动更新

客户端启动 30 秒后检查更新，之后每 4 小时检查一次。更新在后台下载，发布任务运行时不允许重启安装。GitHub Actions 只负责构建、签名、公证和保存 Artifact；开发者电脑通过本地脚本上传腾讯云 COS，版本化安装包先上传，更新清单最后上传。

Beta 灰度发布见 [`docs/BETA-ROLLOUT.md`](docs/BETA-ROLLOUT.md)。正式版用户只有输入有效邀请码后才会切换到 Beta 更新通道。
统一版本命名、验收、回退和清理规则见 [`docs/RELEASE-POLICY.md`](docs/RELEASE-POLICY.md)。

发布新版本：

1. 更新 `package.json`、Go CLI 和内置 Skill 的版本。
2. 完成测试和 Windows 打包验证。
3. 创建与版本完全一致的 Git 标签，例如 `v0.1.0-beta.1`。
4. 等待 Release workflow 生成 Windows 和 macOS Artifact。
5. 在开发机执行 `./scripts/publish-cos-local.sh <Run ID> beta`；正式版使用 `stable`。

腾讯云密钥只能保存在被 Git 忽略的 `.env.cos`，禁止写入源码、日志或安装包。
