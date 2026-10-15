# 手动构建 Mac DMG（GitHub 下载）

`Build macOS DMG` 生成供用户直接安装的 Apple Silicon（M 系列芯片）安装包。
配置位于 `.github/workflows/build-mac-dmg.yml`，目前仅支持手动运行。
此流程只向 GitHub Actions 保存附件，不读取腾讯云凭据，不上传 COS，也不更新发布通道或提交苹果商店。

## 构建与下载

1. 默认分支 `main` 中需存在工作流文件，GitHub 才会显示手动运行入口。
2. 打开 [Build macOS DMG](https://github.com/lJx338/geo-pub/actions/workflows/build-mac-dmg.yml)，点击 **Run workflow**。
3. 选择包含该工作流及脚本的代码分支（例如 `v0.6.2`），再次点击 **Run workflow**。
4. 工作流安装依赖、执行类型检查、Go 测试和现有自动化测试，然后编译应用及 CLI。
5. 使用 Developer ID 签名应用及内置 CLI，向苹果申请公证，并检查最终 DMG 的完整性、挂载、版本、架构、签名、公证票据和 Gatekeeper 验证结果。
6. 所有检查通过后，在运行页面的 **Artifacts** 下载 `GEO-Publisher-<版本>-mac-arm64-dmg-<运行编号>-<重跑次数>`。需登录有仓库读取权限的 GitHub 账号，附件保留 14 天。
7. 解压附件，取得 `.dmg`、`SHA256SUMS.txt` 和 `build-info.json`。后者记录版本、源码提交、构建编号及 SHA-256。可以将下载后的 DMG 单独发给用户，无需用户登录 GitHub。

工作流复用仓库的 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` Secrets；不使用 MAS 商店签名证书。
公证、签名或安装包验证失败时不会提供可分发附件。真实平台登录、文章发布和完整用户操作仍需在 Mac 上验收。

## 已经安装 TestFlight / 商店版的用户

用户可以安装通过签名和公证的 DMG，无需具有 TestFlight 内测资格。
项目的两种构建都使用 `GEO Publisher.app` 和 `com.lingxi.geo-publisher`，安装到相同位置可能替换已有应用，不应视为彼此独立的两个应用。

- 先备份原应用内的重要数据并完全退出，再安装 DMG；不要让两个版本同时运行。
- 商店版使用 Electron 提供的沙盒数据目录，普通 DMG 使用 `~/Library/Application Support/GEO Publisher Desktop`。目前不自动迁移文章、客户数据和平台登录态；重新安装应用不等于迁移数据。
- 安装后重新检查平台登录，并点击“连接 WorkBuddy”更新连接指令。
- DMG 的新版本需重新下载并安装，不由 TestFlight 分发。本次仅新增构建流程，应用中既有的 COS 检查更新逻辑没有更改；COS 不可用时，检查更新可能报错。

## 以后改为推送自动构建

在同一工作流的 `on` 下添加限定分支的 `push`，并保留 `workflow_dispatch`，即可同时支持自动和手动构建。例如：

```yaml
on:
  workflow_dispatch:
  push:
    branches: [main]
```

这只是未来配置示例，当前工作流没有开启推送触发。自动构建仍然只保存 GitHub 附件，发布到其他渠道需单独配置。
