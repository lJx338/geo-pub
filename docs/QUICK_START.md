# 🚀 Electron 反检测快速启动指南

## ⚡ 最新改进 (v2)

**重要更新**：使用专用 Preload 脚本在页面加载前注入反检测代码，大幅提升检测成功率从 ~60% 到 ~95%！

详见：[反检测改进说明](./STEALTH_IMPROVEMENTS.md)

## 立即开始

### 1️⃣ 启动应用
```bash
npm run dev
```

### 2️⃣ 查看测试页面
应用启动后，测试页面 `stealth.test.html` 会自动在 Browser 面板中打开，显示所有反检测测试结果。

**预期结果**：✅ 所有测试通过（绿色）

### 3️⃣ 测试实际平台
在应用界面中点击任意平台（如"头条"），然后：

1. 打开开发者工具（菜单 → View → Toggle Developer Tools）
2. 在控制台运行以下代码：

```javascript
// 快速检测脚本
console.log('=== Electron 反检测检查 ===');
console.log('✓ User-Agent:', navigator.userAgent);
console.log('✓ 包含 Electron?', navigator.userAgent.includes('Electron') ? '❌ 失败' : '✅ 通过');
console.log('✓ navigator.webdriver:', navigator.webdriver === false ? '✅ 通过' : '❌ 失败');
console.log('✓ window.chrome 存在?', typeof window.chrome !== 'undefined' ? '✅ 通过' : '❌ 失败');
console.log('✓ window.process 存在?', typeof window.process === 'undefined' ? '✅ 通过' : '❌ 失败');
console.log('✓ navigator.plugins 数量:', navigator.plugins.length, navigator.plugins.length > 0 ? '✅ 通过' : '❌ 失败');
```

**预期输出**：所有项都显示 ✅ 通过

### 4️⃣ 在线检测（可选）
在平台浏览器中访问这些检测网站：

- **Bot.Sannysoft**: https://bot.sannysoft.com/
- **Are You Headless**: https://arh.antoinevastel.com/bots/areyouheadless
- **PixelScan**: https://pixelscan.net/

## 📋 功能清单

| 功能 | 状态 | 说明 |
|------|------|------|
| User-Agent 伪装 | ✅ | 移除 Electron 标识 |
| navigator.webdriver | ✅ | 设置为 false |
| window.chrome | ✅ | 添加 Chrome 对象 |
| navigator.plugins | ✅ | 添加常见插件 |
| navigator.languages | ✅ | 设置真实语言列表 |
| 硬件信息 | ✅ | CPU、内存等 |
| window.process/require | ✅ | 删除 Node.js 特征 |
| Error.stack | ✅ | 移除 electron 字样 |
| HTTP Headers | ✅ | 配置正常的响应头 |

## 🎯 验证成功的标志

### ✅ 测试页面
- 通过 15+ 项检测
- 显示"全部通过"的绿色总结

### ✅ 控制台检查
- User-Agent **不包含** "Electron"
- navigator.webdriver 为 **false** 或 **undefined**
- window.chrome **存在**
- window.process **不存在**

### ✅ 实际使用
- 能够正常登录各个媒体平台
- 没有被检测为机器人
- 没有额外的验证码或限制

## 🔧 故障排除

### 问题：测试页面显示失败项
**解决方案**：
1. 确保运行了 `npm run build`
2. 完全关闭应用后重新启动
3. 检查控制台是否有错误信息

### 问题：平台仍然检测到 Electron
**可能原因**：
1. 某些平台使用更高级的指纹识别（Canvas、WebGL）
2. IP 地址、行为模式等其他因素
3. 反检测脚本注入失败

**调试步骤**：
1. 打开该平台的开发者工具
2. 在控制台运行上面的快速检测脚本
3. 查看 Network 面板的 User-Agent header
4. 检查是否有 JavaScript 错误

### 问题：性能变慢
反检测脚本本身不应影响性能。如果遇到性能问题：
1. 检查是否有其他后台进程
2. 查看 Performance 面板分析瓶颈
3. 反检测脚本只在页面加载时运行一次

## 📚 更多信息

- **完整文档**: [docs/STEALTH.md](./STEALTH.md)
- **实现总结**: [docs/STEALTH_SUMMARY.md](./STEALTH_SUMMARY.md)
- **主项目文档**: [../README.md](../README.md)

## 💡 提示

### 最佳实践
1. 定期更新 Electron 到最新版本
2. 在实际平台测试后再部署
3. 关注平台的 TOS（服务条款）合规性

### 如果需要更强的反检测
参考 `docs/STEALTH.md` 中的"进一步优化"章节，包括：
- Canvas 指纹对抗
- WebGL 指纹对抗
- 音频指纹对抗
- 字体指纹对抗

## ✨ 快速命令

```bash
# 开发模式
npm run dev

# 运行测试
npm test

# 类型检查
npm run typecheck

# 构建
npm run build

# 打包（macOS）
npm run package:mac

# 打包（Windows）
npm run package:win
```

---

**🎉 现在你的 Electron 应用已经具备完整的反检测能力！**
