import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Platform } from '../shared/protocol.js';
import { dataDirectory } from './runtime-paths.js';

export type PublishJournalState = 'prepared' | 'dispatching' | 'dispatched' | 'success' | 'action_required' | 'result_uncertain';

export interface PublishTaskJournal {
  taskId: string;
  platform: Platform;
  contentHash: string;
  state: PublishJournalState;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
}

export function publishContentHash(input: { platform: Platform; title: string; html: string; coverPath: string; tags: string[] }): string {
  return createHash('sha256').update(JSON.stringify({
    platform: input.platform,
    title: input.title.trim(),
    html: input.html,
    coverPath: input.coverPath,
    tags: [...input.tags].map((tag) => tag.trim()).filter(Boolean).sort(),
  })).digest('hex');
}

export class PublishTaskJournalStore {
  constructor(private readonly rootDirectory?: string) {}

  async prepare(input: { platform: Platform; title: string; html: string; coverPath: string; tags: string[] }): Promise<PublishTaskJournal> {
    const contentHash = publishContentHash(input);
    const prior = await this.findRecent(input.platform, contentHash);
    if (prior && ['dispatching', 'dispatched', 'result_uncertain'].includes(prior.state)) {
      throw new Error(`RESULT_UNCERTAIN: 检测到同内容未完成对账的发布任务 ${prior.taskId}，禁止自动重发`);
    }
    if (prior?.state === 'success') return prior;
    const now = new Date().toISOString();
    const journal: PublishTaskJournal = {
      taskId: randomUUID(), platform: input.platform, contentHash, state: 'prepared', createdAt: now, updatedAt: now,
    };
    await this.write(journal);
    return journal;
  }

  async update(journal: PublishTaskJournal, state: PublishJournalState, result?: unknown): Promise<PublishTaskJournal> {
    const updated = { ...journal, state, updatedAt: new Date().toISOString(), ...(result === undefined ? {} : { result }) };
    await this.write(updated);
    return updated;
  }

  /** Keeps unresolved publish attempts as the duplicate-publish guard. */
  async prune(now = Date.now(), maxCompleted = 1000, maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch {
      return 0;
    }
    const completed: Array<{ path: string; updatedAt: number }> = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const path = join(this.directory(), name);
      try {
        const journal = JSON.parse(await readFile(path, 'utf8')) as PublishTaskJournal;
        if (['dispatching', 'dispatched', 'result_uncertain'].includes(journal.state)) continue;
        completed.push({ path, updatedAt: Date.parse(journal.updatedAt) || 0 });
      } catch {
        // Invalid historical files are left for manual inspection.
      }
    }
    completed.sort((left, right) => right.updatedAt - left.updatedAt);
    const removals = completed.filter((entry, index) => index >= maxCompleted || entry.updatedAt < now - maxAgeMs);
    await Promise.all(removals.map(async ({ path }) => await rm(path, { force: true })));
    return removals.length;
  }

  private directory(): string {
    return this.rootDirectory ?? join(dataDirectory(), 'publish-journal');
  }

  private path(taskId: string): string {
    return join(this.directory(), `${taskId}.json`);
  }

  private async findRecent(platform: Platform, contentHash: string): Promise<PublishTaskJournal | null> {
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch {
      return null;
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        const journal = JSON.parse(await readFile(join(this.directory(), name), 'utf8')) as PublishTaskJournal;
        if (journal.platform === platform && journal.contentHash === contentHash && Date.parse(journal.updatedAt) >= cutoff) return journal;
      } catch {
        // A corrupt historical journal cannot prevent a fresh task from running.
      }
    }
    return null;
  }

  private async write(journal: PublishTaskJournal): Promise<void> {
    const directory = this.directory();
    await mkdir(directory, { recursive: true });
    const temporary = `${this.path(journal.taskId)}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
    await rename(temporary, this.path(journal.taskId));
  }
}
