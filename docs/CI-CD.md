# CI/CD 发布流程

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
