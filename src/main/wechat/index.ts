import { dataDirectory } from '../runtime-paths.js';
import { WechatAdapter } from './adapter.js';
import { BODY_IMAGE_LIMIT, type WechatMaterialResolver } from './document.js';
import { WechatError } from './errors.js';
import { WechatStore } from './storage.js';

export { WechatAdapter } from './adapter.js';
export { WechatApiClient } from './api.js';
export { WechatStore } from './storage.js';
export { WechatError, safeWechatError } from './errors.js';
export * from './types.js';

/** Call in the Electron main process, after app.whenReady(). */
export async function createElectronWechatAdapter(options: { root?: string; resolveMaterial?: WechatMaterialResolver } = {}): Promise<WechatAdapter> {
  const { app, nativeImage, safeStorage } = await import('electron');
  if (!app.isReady()) throw new Error('Wechat adapter requires app.whenReady()');
  const store = new WechatStore(options.root ?? dataDirectory(), {
    available: () => safeStorage.isEncryptionAvailable()
      && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value),
  });
  return new WechatAdapter({
    store,
    resolveMaterial: options.resolveMaterial,
    compressBodyImage: (bytes) => {
      const source = nativeImage.createFromBuffer(bytes);
      if (source.isEmpty()) throw new WechatError('WECHAT_IMAGE_FORMAT', '请使用有效的 PNG 或 JPEG 正文图片');
      const { width, height } = source.getSize();
      const longEdge = Math.max(width, height);
      for (let maxEdge = Math.min(longEdge, 2400); maxEdge >= 1; maxEdge = Math.floor(maxEdge * 0.7)) {
        const scale = maxEdge / longEdge;
        const resized = scale === 1 ? source : source.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        });
        for (const quality of [90, 80, 65, 50]) {
          const jpeg = resized.toJPEG(quality);
          if (jpeg.length > 0 && jpeg.length < BODY_IMAGE_LIMIT) return jpeg;
        }
      }
      throw new WechatError('WECHAT_IMAGE_SIZE', '正文图片自动压缩失败，请更换图片');
    },
  });
}
