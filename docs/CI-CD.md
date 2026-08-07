# CI/CD 发布流程

以后每次发布都使用同一个版本标签，Windows 和 macOS 会并行构建并上传到腾讯云 COS。

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

GitHub Actions 会自动执行测试、构建、签名、公证，并分别上传：

- `geo-publisher/releases/versions/<version>/win-x64/`
- `geo-publisher/releases/versions/<version>/mac-arm64/`
- 对应的 `geo-publisher/releases/channels/<channel>/` 清单

正式版本标签不包含 `-alpha` 或 `-beta` 时，自动上传到 `stable` 目录。

## GitHub Secrets

Windows：`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。

macOS：`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

COS：`TENCENT_CLOUD_SECRET_ID`、`TENCENT_CLOUD_SECRET_KEY`；仓库 Variables 配置 `TENCENT_COS_BUCKET`、`TENCENT_COS_REGION`、可选的 `TENCENT_COS_PREFIX`。

macOS 公证所需的 App 专用密码只存 GitHub Secrets，不写入仓库或本地配置。

## 回退

如果 macOS 公证服务临时不可用，保留 `upload-mac-release.yml` 手动补传入口。它只负责上传已经公证的 macOS 文件，不会覆盖 Windows 版本。

已经安装的新版本不会自动降级。发现正式版问题时应发布更高的补丁版本；通道清单切回旧版本只用于阻止尚未升级的客户端继续下载问题版本。

完整发版规则见 [`RELEASE-POLICY.md`](RELEASE-POLICY.md)。
