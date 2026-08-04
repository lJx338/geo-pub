import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopStatus, Platform, PlatformStatus } from './shared/protocol.js';

// 反检测：确保不暴露任何Electron相关的全局对象
// 删除可能被注入的 process 和 require
if (typeof window !== 'undefined') {
  // @ts-expect-error - 删除可能的Electron特征
  delete window.process;
  // @ts-expect-error - 删除可能的Electron特征
  delete window.require;
  // @ts-expect-error - 删除可能的Electron特征
  delete window.module;
  // @ts-expect-error - 删除可能的Electron特征
  delete window.__dirname;
  // @ts-expect-error - 删除可能的Electron特征
  delete window.__filename;
}

contextBridge.exposeInMainWorld('geoPublisher', {
  status: (): Promise<DesktopStatus> => ipcRenderer.invoke('geo:status'),
  openPlatform: (platform: Platform): Promise<PlatformStatus> => ipcRenderer.invoke('geo:open-platform', platform),
});

