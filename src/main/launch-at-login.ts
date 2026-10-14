import type { App } from 'electron';
import type { LaunchAtLoginStatus } from '../shared/protocol.js';

type LoginItemApp = Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>;

export function getLaunchAtLoginStatus(
  app: LoginItemApp,
  platform = process.platform,
  windowsStore = process.windowsStore,
  executablePath = process.execPath,
): LaunchAtLoginStatus {
  if (platform === 'win32' && windowsStore) {
    return {
      available: true, enabled: null, management: 'system',
      message: '在 Windows 启动设置中开启或关闭 Lingxi Workspace。开启后，登录电脑时会自动启动。',
    };
  }
  if (!app.isPackaged || !['win32', 'darwin'].includes(platform)) {
    return { available: false, enabled: false, management: 'app', message: '安装后的 Windows 或 macOS 版本支持开机启动。' };
  }
  const settings = platform === 'win32'
    ? app.getLoginItemSettings({ path: executablePath, args: ['--background'] })
    : app.getLoginItemSettings();
  const enabled = settings.openAtLogin && (platform !== 'win32' || settings.executableWillLaunchAtLogin !== false);
  return {
    available: true, enabled, management: 'app',
    message: settings.openAtLogin && !enabled
      ? 'Windows 已禁用此启动项，重新开启后将在登录电脑时自动启动。'
      : '开启后，登录电脑时会自动启动，WorkBuddy 随时可以连接桌面端。',
  };
}

export function setLaunchAtLogin(
  app: LoginItemApp,
  enabled: boolean,
  platform = process.platform,
  windowsStore = process.windowsStore,
  executablePath = process.execPath,
): LaunchAtLoginStatus {
  const status = getLaunchAtLoginStatus(app, platform, windowsStore, executablePath);
  if (status.management === 'system') throw new Error('请在 Windows 启动设置中修改 Lingxi Workspace 的开机启动。');
  if (!status.available) return status;
  if (platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, enabled, path: executablePath, args: ['--background'] });
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: ['--background'] });
  }
  return getLaunchAtLoginStatus(app, platform, windowsStore, executablePath);
}

export async function openWindowsStartupSettings(
  openExternal: (url: string) => Promise<void>,
  platform = process.platform,
): Promise<{ opened: true }> {
  if (platform !== 'win32') throw new Error('Windows 启动设置仅适用于 Windows。');
  await openExternal('ms-settings:startupapps');
  return { opened: true };
}
