import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from 'electron';
import { PLATFORMS, type Platform } from '../shared/protocol.js';
import { dataDirectory, evidenceDirectory } from './runtime-paths.js';
import { PublishTaskJournalStore } from './publish-task-journal.js';
import { PublishTaskHistoryStore } from './publish-task-history.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const EVIDENCE_MAX_AGE_MS = 30 * DAY_MS;
export const EVIDENCE_MAX_BYTES = 200 * 1024 * 1024;
export const CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const CACHE_TARGET_BYTES = 800 * 1024 * 1024;

export interface MaintenanceResult {
  ranAt: string;
  evidenceBytes: number;
  deletedEvidenceFiles: number;
  deletedStalePartitions: number;
  clearedCache: boolean;
  cacheBytes: number;
  prunedJournalRecords: number;
  prunedTaskHistoryRecords: number;
}

interface EvidenceFile {
  path: string;
  platform: Platform | null;
  failed: boolean;
  bytes: number;
  modifiedAt: number;
}

export function isFailureEvidence(name: string): boolean {
  return /(failure|failed|action_required|uncertain|timeout)/i.test(name);
}

export async function maintainEvidence(
  root = evidenceDirectory(),
  now = Date.now(),
  maxBytes = EVIDENCE_MAX_BYTES,
): Promise<{ bytes: number; deleted: number }> {
  const files = await evidenceFiles(root);
  const protectedPaths = new Set<string>();
  for (const platform of PLATFORMS) {
    const latestFailure = files
      .filter((file) => file.platform === platform && file.failed)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
    if (latestFailure) protectedPaths.add(latestFailure.path);
  }
  let total = files.reduce((sum, file) => sum + file.bytes, 0);
  let deleted = 0;
  for (const file of [...files].sort((left, right) => {
    if (left.failed !== right.failed) return left.failed ? 1 : -1;
    return left.modifiedAt - right.modifiedAt;
  })) {
    if (protectedPaths.has(file.path)) continue;
    if (file.modifiedAt >= now - EVIDENCE_MAX_AGE_MS && total <= maxBytes) continue;
    await rm(file.path, { force: true });
    total -= file.bytes;
    deleted += 1;
  }
  await removeEmptyDirectories(root);
  return { bytes: Math.max(0, total), deleted };
}

export async function registeredProjectIds(projectFile = join(dataDirectory(), 'projects.json')): Promise<Set<string> | null> {
  try {
    const json = JSON.parse(await readFile(projectFile, 'utf8')) as unknown;
    const ids = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string') {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) ids.add(value.toLowerCase());
      } else if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(collect);
      }
    };
    collect(json);
    return ids;
  } catch {
    return null;
  }
}

export async function removeStaleProjectPartitions(
  partitionsDirectory = join(dataDirectory(), 'Partitions'),
  projectFile = join(dataDirectory(), 'projects.json'),
  now = Date.now(),
): Promise<number> {
  const projectIds = await registeredProjectIds(projectFile);
  if (!projectIds) return 0;
  let entries: string[];
  try {
    entries = await readdir(partitionsDirectory);
  } catch {
    return 0;
  }
  const platforms = PLATFORMS.join('|');
  const pattern = new RegExp(`^geo-publisher-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(${platforms})$`, 'i');
  let removed = 0;
  for (const name of entries) {
    const match = pattern.exec(name);
    if (!match || !match[1] || projectIds.has(match[1].toLowerCase())) continue;
    const path = join(partitionsDirectory, name);
    try {
      const metadata = await stat(path);
      if (now - metadata.mtimeMs < EVIDENCE_MAX_AGE_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A transient profile lock must never interrupt publishing.
    }
  }
  return removed;
}

type CacheSession = Pick<Session, 'getCacheSize' | 'clearCache' | 'clearCodeCaches'>;

export async function maintainSessionCaches(
  sessions: CacheSession[],
  protectedSession: CacheSession | null = null,
): Promise<{ cacheBytes: number; cleared: boolean }> {
  const measured = await Promise.all(sessions.map(async (platformSession) => {
    try {
      return { platformSession, bytes: await platformSession.getCacheSize() };
    } catch {
      return { platformSession, bytes: 0 };
    }
  }));
  let cacheBytes = measured.reduce((sum, item) => sum + item.bytes, 0);
  if (cacheBytes <= CACHE_LIMIT_BYTES) return { cacheBytes, cleared: false };

  let cleared = false;
  const candidates = measured
    .filter(({ platformSession }) => platformSession !== protectedSession)
    .sort((left, right) => right.bytes - left.bytes);
  for (const { platformSession, bytes } of candidates) {
    if (cacheBytes <= CACHE_TARGET_BYTES) break;
    try {
      await platformSession.clearCache();
      await platformSession.clearCodeCaches({});
      cacheBytes = Math.max(0, cacheBytes - bytes);
      cleared = true;
    } catch {
      // Cache cleanup is best effort and does not touch login storage.
    }
  }
  return { cacheBytes, cleared };
}

export async function runResourceMaintenance(sessions: Session[], protectedSession: Session | null = null): Promise<MaintenanceResult> {
  const [evidence, deletedStalePartitions, cache, prunedJournalRecords, prunedTaskHistoryRecords] = await Promise.all([
    maintainEvidence(),
    removeStaleProjectPartitions(),
    maintainSessionCaches(sessions, protectedSession),
    new PublishTaskJournalStore().prune(),
    new PublishTaskHistoryStore().prune(),
  ]);
  return {
    ranAt: new Date().toISOString(),
    evidenceBytes: evidence.bytes,
    deletedEvidenceFiles: evidence.deleted,
    deletedStalePartitions,
    clearedCache: cache.cleared,
    cacheBytes: cache.cacheBytes,
    prunedJournalRecords,
    prunedTaskHistoryRecords,
  };
}

async function evidenceFiles(root: string): Promise<EvidenceFile[]> {
  let days: string[];
  try {
    days = await readdir(root);
  } catch {
    return [];
  }
  const files: EvidenceFile[] = [];
  for (const day of days) {
    const directory = join(root, day);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      try {
        const metadata = await stat(path);
        if (!metadata.isFile()) continue;
        const platform = PLATFORMS.find((candidate) => name.includes(`-${candidate}-`)) ?? null;
        files.push({ path, platform, failed: isFailureEvidence(name), bytes: metadata.size, modifiedAt: metadata.mtimeMs });
      } catch {
        // Files can disappear while maintenance runs.
      }
    }
  }
  return files;
}

async function removeEmptyDirectories(root: string): Promise<void> {
  let days: string[];
  try {
    days = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(days.map(async (day) => {
    const directory = join(root, day);
    try {
      if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true, force: true });
    } catch {
      // A concurrent screenshot write wins over cleanup.
    }
  }));
}
