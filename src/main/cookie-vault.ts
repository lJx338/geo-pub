import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeStorage, type Session } from 'electron';
import type { Platform } from '../shared/protocol.js';
import { dataDirectory } from './runtime-paths.js';

const PLATFORM_DOMAINS: Record<Platform, string[]> = {
  baijia: ['baidu.com'],
  toutiao: ['toutiao.com'],
  zhihu: ['zhihu.com'],
  penguin: ['qq.com'],
  sohu: ['sohu.com'],
  netease: ['163.com', '126.net'],
};

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

function vaultPath(platform: Platform): string {
  return join(dataDirectory(), 'session-vault', `${platform}.bin`);
}

function belongsToPlatform(platform: Platform, domain: string): boolean {
  const normalized = domain.replace(/^\./, '').toLowerCase();
  return PLATFORM_DOMAINS[platform].some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

export async function snapshotPlatformCookies(partition: Session, platform: Platform): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return;
  const cookies = (await partition.cookies.get({}))
    .filter((cookie) => Boolean(cookie.domain) && belongsToPlatform(platform, cookie.domain!))
    .map(({ name, value, domain, path, secure, httpOnly, session, expirationDate, sameSite }) => ({
      name, value, domain: domain!, path: path || '/', secure: Boolean(secure), httpOnly: Boolean(httpOnly),
      session: Boolean(session), expirationDate, sameSite,
    } satisfies StoredCookie));
  if (!cookies.length) return;
  const path = vaultPath(platform);
  const temporary = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, safeStorage.encryptString(JSON.stringify(cookies)), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function restorePlatformCookies(partition: Session, platform: Platform): Promise<number> {
  if (!safeStorage.isEncryptionAvailable()) return 0;
  let encrypted: Buffer;
  try {
    encrypted = await readFile(vaultPath(platform));
  } catch {
    return 0;
  }
  let cookies: StoredCookie[];
  try {
    cookies = JSON.parse(safeStorage.decryptString(encrypted)) as StoredCookie[];
  } catch {
    return 0;
  }
  let restored = 0;
  for (const cookie of cookies) {
    if (!belongsToPlatform(platform, cookie.domain)) continue;
    const host = cookie.domain.replace(/^\./, '');
    const details = {
      url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(cookie.session || !cookie.expirationDate ? {} : { expirationDate: cookie.expirationDate }),
    };
    try {
      await partition.cookies.set(details);
      restored += 1;
    } catch {
      // A stale or platform-invalid cookie must not prevent the browser from opening.
    }
  }
  await partition.flushStorageData();
  return restored;
}
