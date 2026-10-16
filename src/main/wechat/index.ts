import { dataDirectory } from '../runtime-paths.js';
import { WechatAdapter } from './adapter.js';
import { WechatStore } from './storage.js';
import type { WechatMaterialResolver } from './document.js';

export { WechatAdapter } from './adapter.js';
export { WechatApiClient } from './api.js';
export { WechatStore } from './storage.js';
export { WechatError, safeWechatError } from './errors.js';
export * from './types.js';

/** Call in the Electron main process, after app.whenReady(). */
export async function createElectronWechatAdapter(options: { root?: string; resolveMaterial?: WechatMaterialResolver } = {}): Promise<WechatAdapter> {
  const { app, safeStorage } = await import('electron');
  if (!app.isReady()) throw new Error('Wechat adapter requires app.whenReady()');
  const store = new WechatStore(options.root ?? dataDirectory(), {
    available: () => safeStorage.isEncryptionAvailable()
      && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value),
  });
  return new WechatAdapter({ store, resolveMaterial: options.resolveMaterial });
}
