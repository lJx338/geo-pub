# CI/CD 发布流程

Mac App Store 使用独立的 `Build Mac App Store` 工作流；操作和沙盒验收见 [Mac App Store 构建指南](MAC-APP-STORE.md)。下面的版本标签及 COS 流程适用于原有商店外安装包。

苹果和微软商店包共用 `build/store-version.json` 的商店版本：例如 `1.0.13` 对应苹果 `1.0.13`、Windows `1.0.13.0`。工作流默认读取该文件，不再按各自运行次数决定商店版本。应用内部版本仍由 `npm run version:set` 单独同步。两种商店安装包统一保存在项目 `release/store/`。

微软商店版通过 `build/appx-startup.xml` 声明 Windows 启动任务，默认关闭。安装并启动应用至少一次后，在应用「设置 → 开机启动 → 打开 Windows 启动设置」中开启 `Lingxi Workspace`；也可以在 Windows「设置 → 应用 → 启动」中修改。支持启动参数的 Windows 版本会以 `--background` 启动。普通 EXE 安装版继续使用应用内开关。

微软商店版的 WorkBuddy 连接会解析 CLI、Skill 文件及连接数据的真实路径，兼容 MSIX 对 AppData 的重定向。内部目录仍为 `GEO Publisher Desktop`，CLI 和发布 Skill 标识仍为 `geo-publisher`；不搬移客户数据。每条 Windows Store CLI 调用须保留连接指令中的 `GEO_PUBLISHER_USER_DATA_DIR` 设置，包括备用的 `cmd.exe` 调用。升级后重新点击“连接 WorkBuddy”刷新本机路径和已安装 Skill。普通 EXE、DMG 和 MAS 使用各自原有的连接方式。

Windows CI 在构建 CLI 后验证路径解析、普通安装包隔离，以及从外部 PowerShell 调用 production CLI 读取实际连接数据；测试使用 junction 模拟目录重定向。真实 MSIX 包发布前仍需在 Windows 上从包外验证连接指令，不能把该模拟测试当作商店安装验收。

`Validate MSIX` 还会检查包内 ASAR 的主程序、preload、界面脚本和独立启动提示页。它在临时 Windows Runner 中给安装包副本签署测试证书，安装并通过 AppsFolder 激活应用；必须记录 `windowsStore: true`、`packaged: true` 和 `renderer.ready` 才算启动成功，且不加 `--disable-gpu`。测试副本和证书随后清理，上传商店的原始包不变。该步骤需要支持桌面包激活的 Windows Runner。

启动阶段、版本、商店身份、preload/页面加载失败和渲染进程退出信息写入数据目录的 `diagnostics/startup.log`（1 MiB 轮转，保留上一份）；目录不可写时回退到系统临时目录，再失败则保留内存记录。错误提示页和原生弹窗都提供复制诊断信息，无需用户运行命令。Windows 错误弹窗提供“兼容模式重启”，选择后会在数据目录记住软件渲染设置。日志不采集客户项目内容、登录 cookie 或控制令牌。`npm run test:startup` 覆盖正常启动及故障场景。

素材创建目录或写入失败时，`diagnostics/materials.log` 记录时间、项目 ID、完整目标路径、操作阶段、系统错误码，以及从文件系统根目录到素材目录各级的存在状态、链接及目标、实际路径和系统写权限检查结果。备用目录保存成功也会记录实际路径。日志按 1 MiB 轮转；日志目录不可写时尝试系统临时目录，再失败则保留内存记录。写权限检查不代表实际写入一定成功，无法判断的字段记为 null。

用户在“设置 → 排障与本地数据 → 导出诊断日志”选择保存位置，即可导出包含近期素材日志、当前目录快照和版本/系统信息的 JSON 文件。报告包含本机路径，不读取图片内容、文章正文、Cookie 或 Token。升级前发生且未被记录的故障无法追溯，需要在新版本中重试。`npm run test:diagnostics` 验证备用目录恢复、取消导出、导出保存失败及成功导出的界面流程；Windows CI 同样执行此测试。

CI 的 `windows-install` 在安装与开机启动界面测试通过后，将普通 Windows EXE 安装包保存到运行页面底部的 Artifacts，名称为 `Lingxi-Workspace-Windows-EXE-<运行编号>`，保留 14 天。该附件仅包含 `release/win-smoke/*.exe`，当前沿用 CI 构建配置，未配置 Windows 代码签名；不自动发布到商店或下载站。

以后每次发布都使用同一个版本标签。GitHub Actions 并行构建 Windows 和 macOS，开发者电脑负责上传腾讯云 COS。禁止从 GitHub Runner 直接上传大文件到 COS。

## 对象存储结构

安装包使用不可变版本目录，更新通道只保存清单指针：

```text
geo-publisher/releases/
├── versions/<version>/<platform>/       # 安装包、blockmap、版本清单
├── channels/stable/<platform>/          # 新正式版客户端清单
├── channels/beta/<platform>/            # 新测试版客户端清单
├── stable/<platform>/                   # 0.2.0 及更早正式版兼容清单
└── beta/<platform>/                     # 历史 beta 客户端迁移到 stable 的兼容清单
```

版本目录中的对象使用一年不可变缓存。通道和兼容清单禁止缓存，并且只在全部安装包上传成功后更新。正式版发布还会刷新旧 beta 清单，使历史测试版用户能够迁移到最新正式版。

## 发布步骤

1. 修改代码和平台适配器。
2. 更新版本号，例如：

   ```bash
   npm run version:set -- 0.3.6-beta.1
   ```

3. 本地验证：

   ```bash
   npm run verify
   ```

4. 提交并推送代码。
5. 创建并推送同名标签：

   ```bash
   git tag v0.3.6-beta.1
   git push origin main --tags
   ```

6. 等待 GitHub Actions 完成测试、构建、签名和公证。工作流会生成两个 Artifact：

- `geo-publisher-windows`
- `geo-publisher-macos-arm64`

7. 打开本次 Actions 运行记录，取得 Run ID，然后在开发机执行：

   ```bash
   ./scripts/publish-cos-local.sh <Run ID> beta
   ```

   正式版使用：

   ```bash
   ./scripts/publish-cos-local.sh <Run ID> stable
   ```

命令会自动下载两个 Artifact，并从开发机上传到：

- `geo-publisher/releases/versions/<version>/win-x64/`
- `geo-publisher/releases/versions/<version>/mac-arm64/`
- 对应的 `geo-publisher/releases/channels/<channel>/` 清单

上传器使用分片并发和网络重试，并核对对象大小。只有该平台全部安装包可访问后，才会更新相应通道清单。

## GitHub Secrets

Windows：`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。

macOS：`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

安装包和更新清单不再使用 GitHub Secrets 上传。开发机使用项目根目录的 `.env.cos`，该文件已被 Git 忽略：

```text
TENCENT_CLOUD_SECRET_ID=<有效 SecretId>
TENCENT_CLOUD_SECRET_KEY=<有效 SecretKey>
TENCENT_COS_BUCKET=lingxi-1303034624
TENCENT_COS_REGION=ap-guangzhou
TENCENT_COS_PREFIX=geo-publisher
```

macOS 公证所需的 App 专用密码仍只存 GitHub Secrets，不写入仓库或本地配置。安装包上传使用的 COS 密钥只存开发机的 `.env.cos`。邀请码记录是很小的 JSON，现有邀请工作流可继续使用 GitHub COS Secrets，不参与安装包上传。

## 回退

如果 macOS 公证服务临时不可用，重新运行失败的 GitHub Actions job。构建产物齐全后仍使用同一条本地 COS 发布命令，不使用单独的云端补传工作流。

已经安装的新版本不会自动降级。发现正式版问题时应发布更高的补丁版本；通道清单切回旧版本只用于阻止尚未升级的客户端继续下载问题版本。

完整发版规则见 [`RELEASE-POLICY.md`](RELEASE-POLICY.md)。
