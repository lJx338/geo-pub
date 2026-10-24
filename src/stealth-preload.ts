/**
 * 专门用于反检测的 Preload 脚本
 * 这个脚本会在页面任何内容加载前执行，确保反检测生效
 *
 * 注意：这个 preload 不使用 contextBridge，因为它专门用于平台浏览器
 */

// 1. 立即删除可能泄露的全局对象
if (typeof window !== 'undefined') {
  // @ts-expect-error - 删除 Electron 特征
  delete window.process;
  // @ts-expect-error - 删除 Electron 特征
  delete window.require;
  // @ts-expect-error - 删除 Electron 特征
  delete window.module;
  // @ts-expect-error - 删除 Electron 特征
  delete window.__dirname;
  // @ts-expect-error - 删除 Electron 特征
  delete window.__filename;
  // @ts-expect-error - 删除 Electron 特征
  delete window.Buffer;
  // @ts-expect-error - 删除 Electron 特征
  delete window.global;
  // @ts-expect-error - 删除可能泄露的函数
  delete window._getElectronVersion;
}

// 2. 在页面脚本加载前修改关键属性
(() => {
  try {
    // 覆盖 navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
      enumerable: true,
    });

    // 添加 window.chrome 对象
    if (!(window as any).chrome) {
      (window as any).chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {},
      };
    }

    // 修复 navigator.plugins（添加常见插件）
    if (navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          {
            0: {type: "application/pdf", suffixes: "pdf", description: "Portable Document Format"},
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "PDF Viewer"
          },
          {
            0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format"},
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "Chrome PDF Viewer"
          },
          {
            0: {type: "application/x-nacl", suffixes: "", description: "Native Client Executable"},
            1: {type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable"},
            description: "Native Client",
            filename: "internal-nacl-plugin",
            length: 2,
            name: "Native Client"
          }
        ],
        configurable: true,
        enumerable: true,
      });
    }

    // 覆盖 navigator.languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      configurable: true,
      enumerable: true,
    });

    // 使用原生 Permissions API，保留 query 的接收者与 PermissionStatus
    // 的事件接口；登录组件可能依赖这些浏览器接口。

    // 添加 navigator.connection
    if (!(navigator as any).connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          onchange: null,
        }),
        configurable: true,
        enumerable: true,
      });
    }

    // 修复 window.outerWidth 和 window.outerHeight
    if (window.outerWidth === 0 || window.outerHeight === 0) {
      Object.defineProperty(window, 'outerWidth', {
        get: () => window.innerWidth,
        configurable: true,
        enumerable: true,
      });
      Object.defineProperty(window, 'outerHeight', {
        get: () => window.innerHeight,
        configurable: true,
        enumerable: true,
      });
    }

    // 使用原生 Error，保留静态方法、构造函数身份和子类行为。

    // 覆盖 navigator.userAgent（双重保险）
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      get: () => originalUA.replace(/Electron\/\S+\s?/g, ''),
      configurable: true,
      enumerable: true,
    });

    // 覆盖 navigator.appVersion
    const originalAppVersion = navigator.appVersion;
    Object.defineProperty(navigator, 'appVersion', {
      get: () => originalAppVersion.replace(/Electron\/\S+\s?/g, ''),
      configurable: true,
      enumerable: true,
    });

    // 添加 navigator.deviceMemory
    if (!(navigator as any).deviceMemory) {
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
        configurable: true,
        enumerable: true,
      });
    }

    // 修正 navigator.hardwareConcurrency
    if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency === 1) {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
        configurable: true,
        enumerable: true,
      });
    }

    // 覆盖 navigator.platform（保持原值但确保可配置）
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', {
      get: () => originalPlatform,
      configurable: true,
      enumerable: true,
    });

  } catch (err) {
    // 静默失败，避免暴露反检测逻辑
  }
})();
