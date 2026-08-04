# Electron 反检测文档

## 概述

本项目已集成了全面的 Electron 反检测功能，让应用的内置浏览器看起来像普通的 Chrome 浏览器，避免被网站检测和拒绝访问。

## 实现的反检测特性

### 1. User-Agent 伪装
- ✅ 自动移除 User-Agent 中的 `Electron/x.x.x` 标识
- ✅ 保留 Chrome 和其他正常的浏览器标识
- ✅ 同时处理 `navigator.userAgent` 和 `navigator.appVersion`

### 2. Navigator 对象修复
- ✅ `navigator.webdriver` 设置为 `false`
- ✅ `navigator.plugins` 添加常见的 Chrome 插件（PDF Viewer、Chrome PDF Viewer、Native Client）
- ✅ `navigator.languages` 设置为真实的语言列表
- ✅ `navigator.hardwareConcurrency` 设置合理的 CPU 核心数
- ✅ `navigator.deviceMemory` 添加设备内存信息
- ✅ `navigator.connection` 添加网络连接信息
- ✅ `navigator.platform` 保留原始值但确保正确性

### 3. Window 对象处理
- ✅ 添加 `window.chrome` 对象（Electron 默认缺失）
- ✅ 修复 `window.outerWidth` 和 `window.outerHeight`
- ✅ 删除 `window.process`、`window.require`、`window.module` 等 Node.js 特征
- ✅ 删除 `window._getElectronVersion` 等可能泄露的函数

### 4. 高级反检测
- ✅ 修复 `Permissions API` 的行为
- ✅ 处理 `Error.stack` 中可能包含的 "electron" 字样
- ✅ 配置 HTTP Headers（移除可能暴露的响应头）
- ✅ 所有反检测代码在页面脚本执行前注入

## 架构

```
src/main/
├── stealth.ts              # 核心反检测模块
├── platform-sessions.ts    # 应用反检测到平台会话
└── index.ts                # 应用反检测到主窗口

src/preload.ts              # Preload 层面的保护
```

### 核心模块：`stealth.ts`

#### `getStealthUserAgent()`
获取去除 Electron 标识的 User-Agent 字符串。

#### `setupStealthSession(session)`
为 Electron Session 配置反检测：
- 设置伪装的 User-Agent
- 配置 HTTP Headers 拦截

#### `injectStealthScript(webContents)`
在页面加载前注入反检测脚本，修复所有可能暴露的浏览器特征。

## 使用方法

反检测功能已经自动集成到项目中，无需额外配置。每个平台的浏览器会话都会自动应用反检测。

### 启动应用
```bash
npm run dev
```

### 测试反检测效果

#### 方法 1：使用内置测试页面
项目包含了一个测试页面 `src/main/stealth.test.html`，已经在 Browser 面板中打开。这个页面会：
- ✅ 检测所有常见的 Electron 特征
- ✅ 显示每项测试的通过/失败状态
- ✅ 给出详细的检测结果和建议

#### 方法 2：访问在线检测网站
打开任意平台后，在开发者工具控制台运行以下代码：

```javascript
// 检查 User-Agent
console.log('User-Agent:', navigator.userAgent);
console.log('包含 Electron?', navigator.userAgent.includes('Electron'));

// 检查 webdriver
console.log('webdriver:', navigator.webdriver);

// 检查 chrome 对象
console.log('chrome 对象存在?', typeof window.chrome !== 'undefined');

// 检查 plugins
console.log('Plugins 数量:', navigator.plugins.length);
```

也可以访问这些在线检测网站：
- https://bot.sannysoft.com/
- https://arh.antoinevastel.com/bots/areyouheadless
- https://pixelscan.net/

#### 方法 3：在实际平台测试
直接在应用中打开各个媒体平台（百家号、头条等），观察是否能正常登录和使用，没有被检测或拒绝。

## 技术细节

### 注入时机
反检测脚本通过两个时机注入：

1. **Session 级别**（`setupStealthSession`）
   - 在创建 Session 时立即配置
   - 影响所有使用该 Session 的页面
   - 处理 User-Agent 和 HTTP Headers

2. **页面级别**（`injectStealthScript`）
   - 在 `dom-ready` 事件触发时注入
   - 在页面脚本执行前运行（`executeJavaScript` 的第二个参数为 `true`）
   - 修改 Navigator 和 Window 对象

### 为什么使用 `dom-ready` 而不是 `did-start-loading`？
- `dom-ready` 在 DOM 构建完成但页面脚本执行前触发
- 使用 `executeJavaScript(..., true)` 可以在"isolated world"中运行，确保在页面脚本之前执行
- 这样可以在页面检测代码运行之前完成所有伪装

### Context Isolation 的影响
项目启用了 `contextIsolation: true`，这意味着：
- ✅ Preload 脚本和页面脚本运行在不同的上下文
- ✅ 页面无法访问 Node.js API（更安全）
- ✅ 需要通过 `contextBridge` 暴露接口
- ✅ 反检测脚本需要在页面上下文中运行

## 常见问题

### Q: 为什么有些网站还是能检测到？
A: 可能的原因：
1. 网站使用了更高级的指纹识别技术（Canvas、WebGL、音频指纹等）
2. IP 地址、时区、屏幕分辨率等其他特征暴露了自动化行为
3. 反检测脚本注入时机太晚

解决方案：
- 检查控制台是否有错误
- 使用开发者工具的 Performance 面板查看脚本执行顺序
- 考虑添加更多的反指纹识别特性

### Q: 如何验证反检测是否生效？
A: 三种方法：
1. 查看内置测试页面 `stealth.test.html`
2. 在控制台手动检查关键属性（见上文"测试反检测效果"）
3. 访问在线机器人检测网站

### Q: 可以禁用反检测吗？
A: 可以，但不推荐。如果需要：
1. 在 `platform-sessions.ts` 中注释掉 `setupStealthSession()` 调用
2. 在 `platform-sessions.ts` 中注释掉 `dom-ready` 事件监听器
3. 在 `index.ts` 中注释掉主窗口的 `setupStealthSession()` 调用

### Q: 性能影响如何？
A: 极小。反检测脚本：
- 只在页面加载时运行一次
- 代码量很小（< 10KB）
- 不涉及持续的监控或拦截
- 对页面性能几乎没有影响

## 进一步优化

如果需要更强的反检测能力，可以考虑：

### 1. 添加 Canvas 指纹对抗
```javascript
// 在 stealth.ts 的 injectStealthScript 中添加
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(...args) {
  // 添加微小的噪声
  return originalToDataURL.apply(this, args);
};
```

### 2. 添加 WebGL 指纹对抗
```javascript
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
  if (parameter === 37445) { // UNMASKED_VENDOR_WEBGL
    return 'Intel Inc.';
  }
  if (parameter === 37446) { // UNMASKED_RENDERER_WEBGL
    return 'Intel Iris OpenGL Engine';
  }
  return getParameter.apply(this, arguments);
};
```

### 3. 添加时区和语言一致性检查
确保 `navigator.language`、`navigator.languages`、`Intl.DateTimeFormat().resolvedOptions().timeZone` 等保持一致。

### 4. 使用真实的浏览器配置
可以从真实的 Chrome 浏览器中提取配置：
```bash
chrome://version/
```
然后将相关参数应用到 Electron。

## 维护建议

1. **定期更新 Chrome 版本**：Electron 版本会影响内置 Chromium 版本，定期更新以获得最新的浏览器特性
2. **监控检测网站**：定期访问机器人检测网站，确保反检测仍然有效
3. **关注 Electron 更新**：新版本可能引入新的特征或改变行为
4. **用户反馈**：如果用户报告某个平台无法访问，可能需要针对性优化

## 安全说明

本反检测功能仅用于：
- ✅ 让合法的桌面应用正常访问网站
- ✅ 避免因技术栈被误判为机器人
- ✅ 提供更好的用户体验

**不应用于**：
- ❌ 绕过安全机制进行恶意活动
- ❌ 自动化刷量、爬虫等违规行为
- ❌ 违反目标网站的服务条款

使用本功能请确保符合目标网站的服务条款和相关法律法规。

## 参考资源

- [Puppeteer Extra Stealth Plugin](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth)
- [Electron Security Best Practices](https://www.electronjs.org/docs/latest/tutorial/security)
- [Bot Detection Techniques](https://antoinevastel.com/bot%20detection/2019/07/19/detecting-chrome-headless-v2.html)

## 更新日志

### v0.1.0-alpha.1 (2026-08-04)
- ✅ 初始实现完整的反检测功能
- ✅ 支持所有平台会话的自动反检测
- ✅ 添加测试页面和文档
