import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Platform, PublishTaskAction, PublishTaskPhase, PublishTaskSnapshot, PublishTaskStatus } from '../shared/protocol.js';
import { replaceFile } from './file-replace.js';
import { dataDirectory } from './runtime-paths.js';

const MAX_HISTORY_RECORDS = 200;
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LEGACY_ACTION_MIGRATION_MARKER = '.legacy-actions-v1';

interface HistoryFile {
  name: string;
  modifiedAt: number;
}

export interface StartTaskInput {
  taskId?: string;
  platform: Platform;
  action: PublishTaskAction;
  phase: PublishTaskPhase;
  title?: string;
  lastKnownUrl?: string;
}

/**
 * Stores only the information needed for the publishing-center UI. It deliberately
 * excludes article HTML and local cover paths so task history does not become a
 * second copy of customer content.
 */
export class PublishTaskHistoryStore {
  constructor(private readonly rootDirectory = join(dataDirectory(), 'task-history')) {}

  async start(input: StartTaskInput): Promise<PublishTaskSnapshot> {
    const now = new Date().toISOString();
    const record: PublishTaskSnapshot = {
      taskId: input.taskId || randomUUID(),
      platform: input.platform,
      action: input.action,
      phase: input.phase,
      status: 'running',
      ...(input.title ? { title: input.title } : {}),
      ...(input.lastKnownUrl ? { lastKnownUrl: input.lastKnownUrl } : {}),
      startedAt: now,
    };
    await this.write(record);
    return record;
  }

  async update(record: PublishTaskSnapshot, updates: Partial<Omit<PublishTaskSnapshot, 'taskId' | 'platform' | 'action' | 'startedAt'>>): Promise<PublishTaskSnapshot> {
    const next = { ...record, ...updates };
    await this.write(next);
    return next;
  }

  async list(limit = MAX_HISTORY_RECORDS): Promise<PublishTaskSnapshot[]> {
    const files = (await this.historyFiles()).slice(0, Math.max(0, limit));
    const records = await Promise.all(files.map(async (file) => {
      try {
        return JSON.parse(await readFile(join(this.rootDirectory, file.name), 'utf8')) as PublishTaskSnapshot;
      } catch {
        return null;
      }
    }));
    return records
      .filter((record): record is PublishTaskSnapshot => record !== null && typeof record.taskId === 'string')
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt))
      .slice(0, limit);
  }

  async migrateLegacyActions(): Promise<number> {
    const marker = join(this.rootDirectory, LEGACY_ACTION_MIGRATION_MARKER);
    try {
      await access(marker);
      return 0;
    } catch {
      // Continue with the one-time migration.
    }
    const removed = await this.removeByAction(['open', 'inspect']);
    await mkdir(this.rootDirectory, { recursive: true });
    await writeFile(marker, new Date().toISOString(), { mode: 0o600 });
    return removed;
  }

  async get(taskId: string): Promise<PublishTaskSnapshot | null> {
    try {
      return JSON.parse(await readFile(this.path(taskId), 'utf8')) as PublishTaskSnapshot;
    } catch {
      return null;
    }
  }

  async clearCompleted(): Promise<number> {
    const records = await this.list(Number.MAX_SAFE_INTEGER);
    const completed = records.filter((record) => record.status !== 'running');
    await Promise.all(completed.map(async (record) => await rm(this.path(record.taskId), { force: true })));
    return completed.length;
  }

  /**
   * A browser worker can exit after a platform has accepted a publish click but
   * before the result is written. Never resume that publish automatically: it
   * must be reconciled by the user from the platform. Fill operations do not
   * have that external side effect, so they are recorded as interrupted.
   */
  async recoverInterrupted(now = Date.now()): Promise<number> {
    const records = await this.list(Number.MAX_SAFE_INTEGER);
    const interrupted = records.filter((record) => record.status === 'running');
    const finishedAt = new Date(now).toISOString();
    await Promise.all(interrupted.map(async (record) => {
      const startedAt = Date.parse(record.startedAt);
      const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : undefined;
      await this.update(record, {
        status: record.action === 'publish' ? 'result_uncertain' : 'failed',
        finishedAt,
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        errorCode: 'WORKER_INTERRUPTED',
        message: record.action === 'publish'
          ? '浏览器进程意外退出，发布结果未知，请先在平台后台确认后再重试。'
          : '浏览器进程意外退出，填充未完成，请重新打开并检查草稿。',
      });
    }));
    return interrupted.length;
  }

  async removeByAction(actions: PublishTaskAction[]): Promise<number> {
    const records = await this.list(Number.MAX_SAFE_INTEGER);
    const removals = records.filter((record) => actions.includes(record.action));
    await Promise.all(removals.map(async (record) => await rm(this.path(record.taskId), { force: true })));
    return removals.length;
  }

  async prune(now = Date.now(), maxRecords = MAX_HISTORY_RECORDS, maxAgeMs = HISTORY_MAX_AGE_MS): Promise<number> {
    const files = await this.historyFiles();
    const removals = files.slice(maxRecords).concat(files.filter((file) => file.modifiedAt < now - maxAgeMs))
      .filter((file, index, all) => all.findIndex((candidate) => candidate.name === file.name) === index);
    await Promise.all(removals.map(async (file) => await rm(join(this.rootDirectory, file.name), { force: true })));
    return removals.length;
  }

  private async historyFiles(): Promise<HistoryFile[]> {
    let entries: string[];
    try {
      entries = (await readdir(this.rootDirectory)).filter((entry) => entry.endsWith('.json'));
    } catch {
      return [];
    }
    const files = await Promise.all(entries.map(async (name) => {
      try {
        return { name, modifiedAt: (await stat(join(this.rootDirectory, name))).mtimeMs };
      } catch {
        return null;
      }
    }));
    return files
      .filter((file): file is HistoryFile => file !== null)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
  }

  private path(taskId: string): string {
    return join(this.rootDirectory, `${taskId}.json`);
  }

  private async write(record: PublishTaskSnapshot): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    const destination = this.path(record.taskId);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await replaceFile(temporary, destination);
  }
}

export function taskStatusForResult(result: unknown): PublishTaskStatus {
  if (!result || typeof result !== 'object') return 'success';
  const status = (result as { status?: unknown }).status;
  if (status === 'action_required' || status === 'result_uncertain') return status;
  return 'success';
}
