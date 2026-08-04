/**
 * Electron反检测模块
 * 用于让Electron浏览器看起来像普通的Chrome浏览器
 */

import { session, WebContents } from 'electron';

const configuredSessions = new WeakSet<Electron.Session>();

/**
 * 获取伪装的User-Agent（去除Electron标识）
 */
export function getStealthUserAgent(): string {
  const originalUA = session.defaultSession.getUserAgent();
  // 移除 Electron/x.x.x 标识
  return originalUA.replace(/Electron\/\S+\s?/g, '');
}

/**
 * 为session配置反检测
 */
export function setupStealthSession(sessionInstance: Electron.Session): void {
  if (configuredSessions.has(sessionInstance)) return;
  configuredSessions.add(sessionInstance);
  setupStealthUserAgent(sessionInstance);

  // 移除 Permissions-Policy 中可能暴露Electron的header
  sessionInstance.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    // 允许自动播放等功能，使行为更像普通浏览器
    delete headers['x-frame-options'];
    delete headers['X-Frame-Options'];
    callback({ responseHeaders: headers });
  });
}

/** 仅移除 Electron UA 标识，不修改页面 JS 指纹。网易号登录会话使用此模式。 */
export function setupStealthUserAgent(sessionInstance: Electron.Session): void {
  sessionInstance.setUserAgent(getStealthUserAgent());
}

/**
 * 获取反检测脚本内容（用于注入）
 */
export function getStealthScript(): string {
  return `
    (() => {
      try {
        // 1. 覆盖 navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
          configurable: true,
        });

        // 2. 覆盖 window.chrome 对象（Electron默认缺失）
        if (!window.chrome) {
          window.chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {},
          };
        }

        // 3. 修复 navigator.plugins 和 navigator.mimeTypes
        // Electron中这些通常为空，但正常Chrome浏览器会有一些插件
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
          });
        }

        // 4. 覆盖 navigator.languages（更真实的语言列表）
        Object.defineProperty(navigator, 'languages', {
          get: () => ['zh-CN', 'zh', 'en-US', 'en'],
          configurable: true,
        });

        // 5. 覆盖 permissions.query（某些网站会检测）
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => {
          if (parameters.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null });
          }
          return originalQuery(parameters);
        };

        // 6. 移除 _getElectronVersion 等可能暴露的函数
        delete window._getElectronVersion;

        // 7. 覆盖 navigator.platform（根据操作系统）
        const platform = navigator.platform;
        Object.defineProperty(navigator, 'platform', {
          get: () => platform,
          configurable: true,
        });

        // 8. 添加 navigator.connection（某些检测会查找这个）
        if (!navigator.connection) {
          Object.defineProperty(navigator, 'connection', {
            get: () => ({
              effectiveType: '4g',
              rtt: 50,
              downlink: 10,
              saveData: false,
              onchange: null,
            }),
            configurable: true,
          });
        }

        // 9. 修复 window.outerWidth 和 window.outerHeight
        // Electron有时会有不自然的值
        if (window.outerWidth === 0 || window.outerHeight === 0) {
          Object.defineProperty(window, 'outerWidth', {
            get: () => window.innerWidth,
            configurable: true,
          });
          Object.defineProperty(window, 'outerHeight', {
            get: () => window.innerHeight,
            configurable: true,
          });
        }

        // 10. 防止通过 Error.stack 检测
        const originalError = Error;
        Error = function(...args) {
          const error = new originalError(...args);
          if (error.stack) {
            error.stack = error.stack.replace(/electron/gi, 'chrome');
          }
          return error;
        };
        Error.prototype = originalError.prototype;

        // 11. 覆盖 navigator.userAgent（双重保险）
        const originalUA = navigator.userAgent;
        Object.defineProperty(navigator, 'userAgent', {
          get: () => originalUA.replace(/Electron\\/\\S+\\s?/g, ''),
          configurable: true,
        });

        // 12. 覆盖 navigator.appVersion
        const originalAppVersion = navigator.appVersion;
        Object.defineProperty(navigator, 'appVersion', {
          get: () => originalAppVersion.replace(/Electron\\/\\S+\\s?/g, ''),
          configurable: true,
        });

        // 13. 防止通过 window.process 检测（虽然已经contextIsolation，但双重保险）
        if (window.process) {
          delete window.process;
        }

        // 14. 防止通过 window.require 检测
        if (window.require) {
          delete window.require;
        }

        // 15. 添加真实的 navigator.deviceMemory
        if (!navigator.deviceMemory) {
          Object.defineProperty(navigator, 'deviceMemory', {
            get: () => 8,
            configurable: true,
          });
        }

        // 16. 添加 navigator.hardwareConcurrency（真实的CPU核心数）
        if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency === 1) {
          Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 8,
            configurable: true,
          });
        }

      } catch (err) {
        // 静默失败，避免暴露反检测逻辑
        console.debug('Stealth initialization completed');
      }
    })();
  `;
}

/**
 * 在页面加载前注入反检测脚本
 * 使用 webRequest 在最早时机注入
 */
export function setupStealthInjection(webContents: WebContents): void {
  // 方法1: 使用 executeJavaScript 在导航前注入
  webContents.on('did-start-navigation', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // 立即注入，在任何页面脚本执行前
      webContents.executeJavaScript(getStealthScript()).catch(() => {
        // 可能页面还未准备好，静默失败
      });
    }
  });

  // 方法2: 在 frame 创建时立即注入
  webContents.on('frame-created', (event, details) => {
    const frame = details.frame;
    if (frame) {
      // 对主 frame 和 iframe 都注入
      frame.executeJavaScript(getStealthScript()).catch(() => {
        // 静默失败
      });
    }
  });

  // 方法3: 在 dom-ready 前再次注入（双重保险）
  webContents.on('dom-ready', () => {
    webContents.executeJavaScript(getStealthScript()).catch(() => {
      // 静默失败
    });
  });
}
