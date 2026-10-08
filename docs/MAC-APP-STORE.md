# Mac App Store 构建与验收

商店名称：Lingxi Workspace；程序内部名称：GEO Publisher。
Bundle ID：`com.lingxi.geo-publisher`；Apple Team ID：`F8X7472LW9`。
当前打包目标为 Apple Silicon（arm64），与现有 Mac DMG 支持的架构一致。

## Windows 电脑如何生成安装包

Windows 负责修改代码和操作网页，GitHub 的 macOS runner 负责生成并签名 `.pkg`。

1. 将本次 MAS 代码和 `.github/workflows/build-mas.yml` 提交到仓库。首次在 GitHub 网页显示手动工作流，需要工作流文件已进入默认分支。
   初次接入阶段，推送 `codex/mas-workbuddy` 分支会自动构建 `1.0`，便于在合并前验证。
2. 打开 [GitHub Actions](https://github.com/lJx338/geo-pub/actions)，选择 **Build Mac App Store**。
3. 点击 **Run workflow**，选择代码分支，版本填写 App Store Connect 中的版本（目前为 `1.0`）。
4. 等待全部步骤成功。脚本会检查 profile、运行测试、打包、检查应用和 CLI 的沙盒签名、检查安装器签名。
5. 在该次运行底部 **Artifacts** 下载 `Lingxi-Workspace-MAS-...`，解压取得 `.pkg`。

这个工作流生成安装包，不会自动上传 App Store Connect、提交审核或发布到 COS。
现有 Windows/DMG 发布流程继续使用原来的工作流和证书。

## GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 保存：

| 名称 | 内容 |
| --- | --- |
| `MAS_CSC_LINK` | Mac App Distribution 证书及私钥导出的 P12，Base64 编码 |
| `MAS_CSC_KEY_PASSWORD` | 上述 P12 密码 |
| `MAS_CSC_INSTALLER_LINK` | Mac Installer Distribution 的 P12，Base64 编码 |
| `MAS_CSC_INSTALLER_KEY_PASSWORD` | 安装器 P12 密码 |
| `MAS_PROVISIONING_PROFILE` | 对应该 Bundle ID 的 Mac App Store profile，Base64 编码 |

仓库和构建产物中不存放私钥或 P12 密码。原来的 Developer ID Application 用于商店外 DMG。
商店构建不走 Developer ID 公证流程。

## WorkBuddy 在商店版中的连接

调用链：WorkBuddy → 安装包中的文本客户端 → 本机认证连接 → Electron → 安装包中的 Go CLI → 原有业务处理。

- 应用使用 Electron 返回的 `userData`，不拼接或覆盖沙盒目录。
- 点击“连接 WorkBuddy”，提示词会带上当前安装位置、实际数据目录和完整调用前缀。
- 命令名称、生产 CLI 的业务校验和返回格式沿用现有实现。Go CLI 由沙盒应用启动，保留在签名后的安装包内。
- 客户端通过 macOS 自带的 `/bin/sh`、`osascript` 和 Foundation 工作，不要求另装 Node 或 Python。
- 两个服务只监听 `127.0.0.1` 随机端口。HTTP 入口要求本机令牌、匹配的 Host，拒绝带 Origin 的网页请求。
- 外部 JSON、素材和封面由客户端读入后传给应用，保存在沙盒中；保存的文章在重启后仍能访问这些导入文件。
- 单次客户端传输上限为 64 MB、64 个文件；较多素材分批导入。单条业务 JSON 保持 5 MB 限制。
- 连接失败不会自动重试发布，避免重复发文。
- 更新或更换安装位置后重新点击“连接 WorkBuddy”，让已有自动化使用新的前缀。

首次商店安装使用独立沙盒数据。当前实现不会自动迁移普通 DMG 的客户数据、文章或平台登录态；两种安装方式之间的迁移需要另行验证和安排。

## 提交前必须完成的 Mac 验收

Windows 上的测试和云端签名检查不能代替沙盒中的实际运行测试。
工作流中 `mas-client.test.ts` 检查系统 JXA 客户端与生产 Go CLI 的连接、文件传递和输出；它运行在普通测试进程中，不能证明签名后的应用拥有全部所需权限。

通过 TestFlight 或使用开发证书签名的 MAS 测试包，在真实 Mac 上依次验证：

1. 首次启动、退出、再次启动、开机启动，以及客户端在应用未启动时发起连接。
2. 点击“连接 WorkBuddy”，执行 `doctor`、`instructions --json`、`project current`。若 macOS 提示文件访问授权，确认实际使用场景可以完成授权。
3. 创建/选择客户项目，读取资料，生成选题和文章，保存后重启检查数据。
4. 导入含中文和空格路径的图片，读取素材、整理索引，给文章选择封面；重启后再次使用。
5. 分别检查六个平台登录、验证码、会话持久化、填充和结果对账。真实发布只在用户明确要求后进行。
6. 检查使用指南的连接按钮、素材整理按钮以及已有 WorkBuddy 自动化。
7. 验证商店版更新交给 App Store，不能进入 COS 灰度更新流程。

发行证书签出的 MAS 包不适合直接双击当作普通 DMG 测试；应走 TestFlight，或使用登记测试设备的开发证书和 profile。
可使用 Mac 上的 [Transporter](https://apps.apple.com/app/transporter/id1450874784) 上传 `.pkg`；Windows 用户也可以后续配置云端上传凭据。当前工作流不包含上传凭据。

## 版本说明

工作流输入 `1.0` 对应商店展示版本 `1.0`，安装包内应用和 CLI 使用规范化版本 `1.0.0`。
构建号由 Actions 运行编号和重跑次数生成，避免同一构建号重复上传。
这组版本只用于 MAS，不修改仓库原来的 Windows/DMG 版本号。

技术依据：[Electron MAS 指南](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)、[Apple 沙盒 helper 指南](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)。
