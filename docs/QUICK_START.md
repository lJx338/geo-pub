# 快速开始

## 客户使用

1. 安装并打开 GEO Publisher。
2. 点击左侧平台名称，完成平台登录。
3. 点击“连接 WorkBuddy”。
4. 切换到 WorkBuddy，粘贴已复制的连接指令并发送。
5. 以后直接告诉 WorkBuddy文章内容、目标平台以及是否正式发布。

“填充”“预览”“看看效果”“不要发布”只会覆盖发布页内容，不会点击发布。只有明确要求真实发布时，WorkBuddy 才能执行 `publish`。

## 常见状态

- “需要登录”：在 GEO Publisher 内完成登录后重试。
- “需要验证码”：在可见的平台页面完成验证后重试。
- “今日次数已用完”：停止该平台，当天不再重试。
- `result_uncertain`：先检查作品管理页，禁止直接再次发布。
- “更新已下载”：等待当前发布任务结束，再点击重启安装。

## 开发验证

```bash
npm run verify
```

Skill 校验：

```bash
python3 /path/to/skill-creator/scripts/quick_validate.py integrations/workbuddy/geo-publisher
```
