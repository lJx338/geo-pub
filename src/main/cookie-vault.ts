import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  hostOnly?: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface RendererStorageSnapshot {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

// A view can be destroyed while its Chromium session stays alive. Hydrate that
// session only once: a later login or logout must remain authoritative.
const restorations = new WeakMap<Session, Promise<number>>();
const snapshots = new Map<string, Promise<void>>();

function vaultPath(projectId: string, platform: Platform): string {
  return join(dataDirectory(), 'projects', projectId, 'session-vault', `${platform}.bin`);
}

// Releases before the customer-project session split stored one encrypted
// backup per platform. Keep it as a one-time migration source for NetEase.
function legacyVaultPath(platform: Platform): string {
  return join(dataDirectory(), 'session-vault', `${platform}.bin`);
}

function legacyMigrationMarkerPath(projectId: string): string {
  return join(dataDirectory(), 'projects', projectId, 'session-vault', 'netease.legacy-imported');
}

function rendererStorageVaultPath(projectId: string, platform: Platform): string {
  return join(dataDirectory(), 'projects', projectId, 'session-vault', `${platform}.renderer.bin`);
}

function belongsToPlatform(platform: Platform, domain: string): boolean {
  const normalized = domain.replace(/^\./, '').toLowerCase();
  return PLATFORM_DOMAINS[platform].some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

export async function snapshotPlatformCookies(partition: Session, projectId: string, platform: Platform): Promise<void> {
  const path = vaultPath(projectId, platform);
  // Read and commit in order, including empty jars after logout. An older
  // asynchronous snapshot must never replace the latest login state.
  const previous = snapshots.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => writeSnapshot(partition, platform, path));
  snapshots.set(path, pending);
  try {
    await pending;
  } finally {
    if (snapshots.get(path) === pending) snapshots.delete(path);
  }
}

// ntes_utid/NTESwebSI only identify the browser; these are the cookies that
// carry the logged-in NetEase account session.
const NETEASE_AUTH_COOKIE_NAMES = new Set(['s_info', 'ntes_yd_sess']);

function hasNeteaseAuthCookie(cookies: StoredCookie[]): boolean {
  return cookies.some((cookie) => NETEASE_AUTH_COOKIE_NAMES.has(cookie.name.toLowerCase()));
}

async function readCookieVault(path: string): Promise<{ found: boolean; cookies: StoredCookie[] | null }> {
  let encrypted: Buffer;
  try {
    encrypted = await readFile(path);
  } catch {
    return { found: false, cookies: null };
  }
  try {
    const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as unknown;
    return { found: true, cookies: Array.isArray(parsed) ? parsed as StoredCookie[] : null };
  } catch {
    return { found: true, cookies: null };
  }
}

async function migrationAlreadyChecked(projectId: string): Promise<boolean> {
  try {
    await access(legacyMigrationMarkerPath(projectId));
    return true;
  } catch {
    return false;
  }
}

async function markMigrationChecked(projectId: string): Promise<void> {
  const path = legacyMigrationMarkerPath(projectId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '1', { mode: 0o600 });
}

async function writeSnapshot(partition: Session, platform: Platform, path: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return;
  const cookies = (await partition.cookies.get({}))
    .filter((cookie) => Boolean(cookie.domain) && belongsToPlatform(platform, cookie.domain!))
    .map(({ name, value, domain, hostOnly, path, secure, httpOnly, session, expirationDate, sameSite }) => ({
      name, value, domain: domain!, path: path || '/', secure: Boolean(secure), httpOnly: Boolean(httpOnly),
      hostOnly, session: Boolean(session), expirationDate, sameSite,
    } satisfies StoredCookie));
  const temporary = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, safeStorage.encryptString(JSON.stringify(cookies)), { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function restorePlatformCookies(partition: Session, projectId: string, platform: Platform): Promise<number> {
  const existing = restorations.get(partition);
  if (existing) { await existing; return 0; }
  const pending = restoreEmptySession(partition, projectId, platform);
  restorations.set(partition, pending);
  try {
    return await pending;
  } catch (error) {
    restorations.delete(partition);
    throw error;
  }
}

export async function snapshotPlatformRendererStorage(projectId: string, platform: Platform, snapshot: RendererStorageSnapshot): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return;
  const trim = (values: Record<string, string>) => Object.fromEntries(Object.entries(values || {}).slice(0, 200).map(([key, value]) => [key.slice(0, 512), String(value).slice(0, 100_000)]));
  const payload = JSON.stringify({ localStorage: trim(snapshot.localStorage), sessionStorage: trim(snapshot.sessionStorage) });
  const path = rendererStorageVaultPath(projectId, platform);
  const temporary = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, safeStorage.encryptString(payload), { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function restorePlatformRendererStorage(projectId: string, platform: Platform): Promise<RendererStorageSnapshot | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  let encrypted: Buffer | null = null;
  try {
    encrypted = await readFile(rendererStorageVaultPath(projectId, platform));
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as Partial<RendererStorageSnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    const read = (value: unknown): Record<string, string> => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([key, item]) => typeof key === 'string' && typeof item === 'string').slice(0, 200) as Array<[string, string]>)
      : {};
    return { localStorage: read(parsed.localStorage), sessionStorage: read(parsed.sessionStorage) };
  } catch {
    return null;
  }
}

async function restoreEmptySession(partition: Session, projectId: string, platform: Platform): Promise<number> {
  if (!safeStorage.isEncryptionAvailable()) return 0;
  const current = await partition.cookies.get({});
  const currentPlatformCookies = current.filter((cookie) => cookie.domain && belongsToPlatform(platform, cookie.domain));
  if (platform !== 'netease' && currentPlatformCookies.length > 0) return 0;

  const projectVault = await readCookieVault(vaultPath(projectId, platform));
  // An empty project vault is the authoritative result of an explicit logout.
  if (projectVault.found && projectVault.cookies?.length === 0) return 0;
  let cookies = projectVault.cookies ?? [];
  let importedLegacy = false;
  if (platform === 'netease' && !hasNeteaseAuthCookie(currentPlatformCookies as StoredCookie[]) && !await migrationAlreadyChecked(projectId)) {
    if (!hasNeteaseAuthCookie(cookies)) {
      const legacyVault = await readCookieVault(legacyVaultPath(platform));
      if (legacyVault.cookies?.length) {
        const merged = new Map(cookies.map((cookie) => [`${cookie.domain}|${cookie.name}|${cookie.path}`, cookie]));
        for (const cookie of legacyVault.cookies) {
          const key = `${cookie.domain}|${cookie.name}|${cookie.path}`;
          if (!merged.has(key)) merged.set(key, cookie);
        }
        cookies = [...merged.values()];
        importedLegacy = true;
      }
    }
    if (hasNeteaseAuthCookie(cookies)) await markMigrationChecked(projectId).catch(() => undefined);
  }
  if (!cookies.length) return 0;
  if (platform === 'netease' && hasNeteaseAuthCookie(currentPlatformCookies as StoredCookie[])) return 0;
  let restored = 0;
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.domain !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    if (!belongsToPlatform(platform, cookie.domain)) continue;
    if (cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1000) continue;
    const host = cookie.domain.replace(/^\./, '');
    const details = {
      url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
      name: cookie.name,
      value: cookie.value,
      // Omitting domain preserves host-only cookies (including __Host- cookies).
      ...((cookie.hostOnly ?? !cookie.domain.startsWith('.')) ? {} : { domain: cookie.domain }),
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
  if (importedLegacy) await writeSnapshot(partition, platform, vaultPath(projectId, platform)).catch(() => undefined);
  return restored;
}
