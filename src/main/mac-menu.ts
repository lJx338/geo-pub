import type { MenuItemConstructorOptions } from 'electron';

export function macMenuTemplate(appName: string, showWindow: () => void): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appName}` },
      ],
    },
    { label: '文件', submenu: [{ role: 'close', label: '关闭窗口' }] },
    { role: 'editMenu', label: '编辑' },
    { label: '显示', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    {
      role: 'windowMenu',
      label: '窗口',
      submenu: [
        // A custom action remains enabled even when closing has hidden the main window.
        { id: 'show-main-window', label: '显示主窗口', accelerator: 'CmdOrCtrl+Shift+1', click: showWindow },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}
