import { describe, expect, it } from 'vitest';
import { configureSandboxUserData, controlEndpoint, dataDirectory, setActiveControlEndpoint } from './runtime-paths.js';

describe('MAS runtime paths', () => {
  it('uses the Electron-provided container even if an old path override is present', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const mas = Object.getOwnPropertyDescriptor(process, 'mas');
    const old = process.env.GEO_PUBLISHER_USER_DATA_DIR;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'mas', { value: true, configurable: true });
      process.env.GEO_PUBLISHER_USER_DATA_DIR = '/legacy/data';
      configureSandboxUserData('/actual container/Application Support/GEO Publisher');
      expect(dataDirectory()).toBe('/actual container/Application Support/GEO Publisher');
      expect(controlEndpoint()).toBe('tcp://127.0.0.1:0');
      setActiveControlEndpoint('tcp://127.0.0.1:32123');
      expect(controlEndpoint()).toBe('tcp://127.0.0.1:32123');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (mas) Object.defineProperty(process, 'mas', mas); else Reflect.deleteProperty(process, 'mas');
      if (old === undefined) delete process.env.GEO_PUBLISHER_USER_DATA_DIR; else process.env.GEO_PUBLISHER_USER_DATA_DIR = old;
      setActiveControlEndpoint(undefined);
    }
  });
});
