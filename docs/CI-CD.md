# CI/CD 发布流程

以后每次发布都使用同一个版本标签，Windows 和 macOS 会并行构建并上传到腾讯云 COS。

## 发布步骤

1. 修改代码和平台适配器。
2. 更新版本号，例如：

   ```bash
   npm run version:set -- 0.1.0-beta.6
   ```

3. 本地验证：

   ```bash
   npm run verify
   ```

4. 提交并推送代码。
5. 创建并推送同名标签：

   ```bash
   git tag v0.1.0-beta.6
   git push origin main --tags
   ```

GitHub Actions 会自动执行测试、构建、签名、公证，并分别上传：

- `geo-publisher/releases/beta/win-x64/`
- `geo-publisher/releases/beta/mac-arm64/`

正式版本标签不包含 `-alpha` 或 `-beta` 时，自动上传到 `stable` 目录。

## GitHub Secrets

Windows：`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。

macOS：`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

COS：`TENCENT_CLOUD_SECRET_ID`、`TENCENT_CLOUD_SECRET_KEY`；仓库 Variables 配置 `TENCENT_COS_BUCKET`、`TENCENT_COS_REGION`、可选的 `TENCENT_COS_PREFIX`。

macOS 公证所需的 App 专用密码只存 GitHub Secrets，不写入仓库或本地配置。

## 回退

如果 macOS 公证服务临时不可用，保留 `upload-mac-release.yml` 手动补传入口。它只负责上传已经公证的 macOS 文件，不会覆盖 Windows 版本。
