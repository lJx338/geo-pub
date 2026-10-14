import type { LoginItemSettings } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { getLaunchAtLoginStatus, openWindowsStartupSettings, setLaunchAtLogin } from './launch-at-login.js';

const executablePath = 'C:\\Program Files\\GEO Publisher\\GEO Publisher.exe';

function fixture(packaged = true) {
  const settings: LoginItemSettings = {
    openAtLogin: false, openAsHidden: false, wasOpenedAtLogin: false, wasOpenedAsHidden: false, restoreState: false,
    status: 'not-registered', executableWillLaunchAtLogin: false, launchItems: [],
  };
  const app = {
    isPackaged: packaged,
    getLoginItemSettings: vi.fn((options?: { path?: string; args?: string[] }) => ({
      ...settings,
      openAtLogin: settings.openAtLogin && options?.path === executablePath && options.args?.join(' ') === '--background',
    })),
    setLoginItemSettings: vi.fn((options: { openAtLogin?: boolean; enabled?: boolean }) => {
      settings.openAtLogin = Boolean(options.openAtLogin);
      settings.executableWillLaunchAtLogin = Boolean(options.enabled);
    }),
  };
  return { app, settings };
}

describe('launch at login', () => {
  it('provides Windows settings for Store apps without consulting registry login items', () => {
    const { app } = fixture(false);
    app.getLoginItemSettings.mockImplementation(() => { throw new Error('registry login items are unavailable'); });
    expect(getLaunchAtLoginStatus(app, 'win32', true, executablePath)).toMatchObject({
      available: true, enabled: null, management: 'system', message: expect.stringContaining('Lingxi Workspace'),
    });
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(() => setLaunchAtLogin(app, true, 'win32', true, executablePath)).toThrow('Windows 启动设置');
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('reads back the same background arguments that it registers for an EXE installation', () => {
    const { app } = fixture();
    expect(setLaunchAtLogin(app, true, 'win32', false, executablePath)).toMatchObject({ available: true, enabled: true, management: 'app' });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, enabled: true, path: executablePath, args: ['--background'] });
    expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({ path: executablePath, args: ['--background'] });
    expect(getLaunchAtLoginStatus(app, 'win32', false, executablePath).enabled).toBe(true);
    expect(setLaunchAtLogin(app, false, 'win32', false, executablePath).enabled).toBe(false);
  });

  it('reports an OS-disabled EXE startup item as disabled', () => {
    const { app, settings } = fixture();
    settings.openAtLogin = true;
    expect(getLaunchAtLoginStatus(app, 'win32', false, executablePath)).toMatchObject({
      enabled: false, message: expect.stringContaining('Windows 已禁用'),
    });
  });

  it('does not register the development Electron executable as a login item', () => {
    const { app } = fixture(false);
    expect(setLaunchAtLogin(app, true, 'win32', false, executablePath)).toMatchObject({ available: false, enabled: false });
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('does not expose unsupported login item APIs on Linux', () => {
    const { app } = fixture();
    expect(getLaunchAtLoginStatus(app, 'linux', false, executablePath).available).toBe(false);
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  it('keeps macOS login settings free of Windows executable matching options', () => {
    const { app } = fixture();
    app.getLoginItemSettings.mockImplementation(() => ({
      openAtLogin: true, openAsHidden: false, wasOpenedAtLogin: false, wasOpenedAsHidden: false, restoreState: false,
      status: 'enabled', executableWillLaunchAtLogin: false, launchItems: [],
    }));
    expect(setLaunchAtLogin(app, true, 'darwin', false, executablePath).enabled).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, openAsHidden: true, args: ['--background'] });
    expect(app.getLoginItemSettings).toHaveBeenLastCalledWith();
  });

  it('opens the native Windows startup page and propagates launch failures', async () => {
    const openExternal = vi.fn(async (_url: string) => {});
    await expect(openWindowsStartupSettings(openExternal, 'win32')).resolves.toEqual({ opened: true });
    expect(openExternal).toHaveBeenCalledWith('ms-settings:startupapps');
    openExternal.mockRejectedValueOnce(new Error('settings could not open'));
    await expect(openWindowsStartupSettings(openExternal, 'win32')).rejects.toThrow('settings could not open');
    openExternal.mockClear();
    await expect(openWindowsStartupSettings(openExternal, 'darwin')).rejects.toThrow('仅适用于 Windows');
    expect(openExternal).not.toHaveBeenCalled();
  });
});
