# Beta 灰度测试

正式版默认只检查 `stable` 通道。只有拿到邀请码的用户，才可以在桌面端左侧点击“获取 Beta 灰度版”，输入邀请码后切换到 Beta 通道。

## 开发者操作

1. 先构建并发布一个带 `-beta.N` 后缀的版本，例如 `0.3.6-beta.1`。推送同名标签后，CI 会把安装包和 `beta-mac.yml` / `beta.yml` 上传到版本目录及 Beta 通道目录。
2. 生成邀请码配置文件：

   ```bash
   node scripts/create-beta-invite.mjs BETA-7H4K9Q
   ```

   命令会生成一个不含邀请码明文的 JSON 文件，并打印需要上传的对象键：`geo-publisher/invites/<sha256>.json`。
3. 使用命令输出的 `hash` 触发邀请码工作流：

   ```bash
   gh workflow run publish-beta-invite.yml -f invite_hash=<hash>
   ```

   GitHub Actions 使用仓库 Secrets 上传邀请码记录。不要把邀请码明文传给工作流，也不要提交生成的 `beta-invites/` 目录。
4. 把 Beta 安装包和邀请码分别发给灰度用户。用户安装当前正式版后输入邀请码，应用会自动检查并下载 Beta 版本。

## 用户操作

1. 打开 GEO Publisher，点击“获取 Beta 灰度版”。
2. 输入收到的 `BETA-...` 邀请码，点击“检查 Beta 更新”。
3. 下载完成后点击“重启并安装更新”。发布任务运行中不会重启。
4. 灰度结束时点击“恢复正式版”，再检查更新即可回到正式通道。

邀请码只保存哈希值和更新通道设置，不保存邀请码明文。邀请码对象可以公开读取，但只有知道邀请码的人能定位到对应对象。

完整版本命名、验收和回退要求见 [`RELEASE-POLICY.md`](RELEASE-POLICY.md)。
