# GEO Publisher Desktop

独立的 Electron 发布器实验项目。它使用内置 Chromium 和持久会话替代 Chrome 扩展、Native Host 与端口桥接，不修改现有 `geo-chrome-publisher-mcp@0.3.7`。

## 当前里程碑

- 六个平台分别使用独立的持久登录会话。
- 应用数据保存在独立的 `GEO Publisher Desktop` 目录，不读取旧扩展或其他工作台的 Cookie。
- 运行时只保留当前平台页面；切换平台会释放旧渲染进程，但保留该平台的 Cookie 和登录状态。
- 桌面端与 CLI 通过当前用户专属的本地 Socket/Named Pipe 通信。
- 控制请求使用本机权限文件中的 256 位令牌认证。
- 头条号支持打开编辑页、覆盖标题和正文、填充后校验、保存截图；当前不会点击发布。
- 内置浏览器关闭后台节流，不依赖 Chrome 扩展、Native Host、固定端口或屏幕坐标。
- **集成全面的 Electron 反检测功能**，让内置浏览器看起来像普通 Chrome 浏览器，避免被平台检测和拒绝访问。详见 [反检测文档](docs/STEALTH.md)。

## 开发运行

```bash
npm install
npm run dev
```

构建独立 CLI：

```bash
npm run build:cli
```

CLI 是独立原生程序，不依赖 Node、Python、WorkBuddy 或 Electron 命令行模式。WorkBuddy、Codex 和其他 Agent 都可以调用它。文章内容通过 stdin 或 JSON 文件传入，避免长正文、中文和特殊字符在命令行参数中损坏。

开发机调用：

```bash
./dist/cli/geo-publisher-darwin-arm64 status
./dist/cli/geo-publisher-darwin-arm64 login toutiao
./dist/cli/geo-publisher-darwin-arm64 inspect toutiao
./dist/cli/geo-publisher-darwin-arm64 fill --input /绝对路径/request.json
```

`request.json`：

```json
{
  "platform": "toutiao",
  "title": "示例标题",
  "html": "<p>示例正文</p>",
  "coverPath": "/绝对路径/cover.jpg"
}
```

也可以从 stdin 调用，适合 Agent：

```bash
printf '%s' '{"platform":"toutiao","title":"示例标题","html":"<p>示例正文</p>","coverPath":"/绝对路径/cover.jpg"}' \
  | geo-publisher fill
```

所有成功和失败结果都是结构化 JSON。环境排查使用 `geo-publisher doctor`。

正式安装后，桌面端会在每次启动时把匹配当前系统的 CLI 自动更新到固定位置：

- macOS：`~/Library/Application Support/GEO Publisher Desktop/bin/geo-publisher`
- Windows：`%LOCALAPPDATA%\GEO Publisher Desktop\bin\geo-publisher.exe`

WorkBuddy 和其他 Agent 应调用这个固定路径，不需要使用其自带 Python，也不需要自行安装 npm 包。

`fill` 会覆盖标题和正文、上传单图封面、选择“不投放广告”并勾选“引用AI”，最后停在“预览并发布”前，不会发布。截图保存在应用数据目录的 `evidence` 文件夹。

## 架构约束

- 客户正式版只安装桌面应用；不会要求客户安装 Node、npm、扩展或 Native Host。
- 后续 MCP 将随桌面应用一起打包，并通过固定可执行文件启动。
- 平台验证码、登录过期和账号风控必须在桌面端可视化处理，不尝试绕过。
- 自动发布继续沿用单平台任务、串行队列、幂等与发布后对账原则。
