# Lingxi Workspace v1.0.18

## Electron 升级与 Windows 商店启动修复

- Electron 从 `43.1.1` 升级并固定到 `43.8.3`，同步更新依赖锁文件，确保本地和 CI 使用同一运行库。
- 包含上游对 MSIX/AppX 中 WebGPU 回退到 SwiftShader 时 GPU 进程被终止的修复。受影响客户曾记录 CodeIntegrity 3033：`vk_swiftshader.dll` 不满足签名级别要求，随后包状态变为 `Modified, NeedsRemediation`。
- 增加 WebGPU fallback 请求测试；Windows 商店安装测试核对 Electron 版本，并在界面就绪后持续检查主进程和包状态 15 秒，保存 CodeIntegrity 与 AppModel-Runtime 诊断日志。
- 不删除或迁移客户数据库，不关闭 Windows 完整性检查或 GPU 沙盒。仍需在受影响电脑使用实际商店包复测。

## 知乎发布修复

- 填写内容后等待草稿编辑器稳定，处理“草稿加载中”提示，避免提前发布。
- 发布前核对标题和正文；改用可见、可操作且未被遮挡的 DOM 按钮，兼容页面缩放和二次确认面板。
- 主发布和二次确认分别只触发一次；回执丢失或结果不确定时提示人工核对，避免自动重发。
- 仅将知乎专栏的文章详情地址识别为发布成功，避免误判编辑页。

## GitHub Actions 自动化验证

- 推送分支自动触发 `CI`：类型检查、单元测试、构建、Go 测试、Windows 安装及知乎发布交互回归测试（使用本地测试页面，不向真实知乎发布）。
- 自动触发 `Validate MSIX for Microsoft Store`：构建商店包、校验清单与资源、测试启动故障恢复、安装临时签名副本并验证启动及包状态。
- 测试结果以对应提交的 Actions 运行记录为准。上传分支和运行测试不代表已向微软商店发布。
