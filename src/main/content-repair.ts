import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { diagnosticError } from './diagnostics.js';

export type ContentRepairNotice = {
  id: string;
  status: 'repaired' | 'failed';
  repairedCount: number;
  message: string;
  backupPath?: string;
};

export function isValidReusePolicy(value: unknown): value is 'standard' | 'evergreen' {
  return value === 'standard' || value === 'evergreen';
}

export function normalizeStoredReusePolicy(value: unknown): 'standard' | 'evergreen' {
  return typeof value === 'string' && value.trim().toLowerCase() === 'evergreen' ? 'evergreen' : 'standard';
}

const invalidPolicy = "reuse_policy IS NULL OR reuse_policy COLLATE BINARY NOT IN ('standard', 'evergreen')";

/** Only repairs stored data. New input must still pass the normal strict schema. */
export function repairContentReusePolicies(database: DatabaseSync, databasePath: string, backupDirectory: string): ContentRepairNotice | null {
  const id = randomUUID();
  let transactionStarted = false;
  let temporaryBackupPath: string | undefined;
  let backupPath: string | undefined;
  try {
    if (!database.prepare(`SELECT 1 FROM content_items WHERE ${invalidPolicy} LIMIT 1`).get()) return null;

    // Hold the writer lock until backup and repair are complete. A separate
    // read connection can take a consistent snapshot, including committed WAL
    // pages, while other writers are prevented from changing the source.
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const rows = database.prepare(`SELECT id, reuse_policy FROM content_items WHERE ${invalidPolicy}`).all() as Array<{ id: string; reuse_policy: SQLOutputValue }>;
    if (!rows.length) {
      database.exec('COMMIT');
      transactionStarted = false;
      return null;
    }

    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString();
    const destination = join(backupDirectory, `content-before-repair-${timestamp.replace(/[:.]/g, '-')}-${id.slice(0, 8)}.sqlite3`);
    temporaryBackupPath = `${destination}.partial`;
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      reader.prepare('VACUUM main INTO ?').run(temporaryBackupPath);
    } finally {
      reader.close();
    }
    chmodSync(temporaryBackupPath, 0o600);
    renameSync(temporaryBackupPath, destination);
    temporaryBackupPath = undefined;
    backupPath = destination;

    // The original value and correction commit together; no article text or
    // other content fields are rewritten. An untyped column preserves NULL,
    // text and any other original SQLite value without coercion.
    database.exec(`CREATE TABLE IF NOT EXISTS content_repair_log (
      repair_id TEXT NOT NULL, content_id TEXT NOT NULL, old_reuse_policy,
      new_reuse_policy TEXT NOT NULL, repaired_at TEXT NOT NULL, backup_path TEXT NOT NULL,
      PRIMARY KEY (repair_id, content_id)
    )`);
    const update = database.prepare('UPDATE content_items SET reuse_policy = ? WHERE id = ?');
    const log = database.prepare('INSERT INTO content_repair_log (repair_id, content_id, old_reuse_policy, new_reuse_policy, repaired_at, backup_path) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of rows) {
      const policy = normalizeStoredReusePolicy(row.reuse_policy);
      update.run(policy, row.id);
      log.run(id, row.id, row.reuse_policy, policy, timestamp, backupPath);
    }
    database.exec('COMMIT');
    transactionStarted = false;
    return {
      id, status: 'repaired', repairedCount: rows.length, backupPath,
      message: `已自动修复 ${rows.length} 条内容数据，原始数据已备份。`,
    };
  } catch (error) {
    if (transactionStarted) {
      try { database.exec('ROLLBACK'); } catch { /* Keep the original failure. */ }
    }
    if (temporaryBackupPath) {
      try { rmSync(temporaryBackupPath, { force: true }); } catch { /* Best effort for an incomplete backup only. */ }
    }
    diagnosticError(`Content reuse policy repair failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      id, status: 'failed', repairedCount: 0, backupPath,
      message: backupPath
        ? '内容数据自动修复失败，原始数据已备份。部分内容暂时无法修改，请联系技术支持。'
        : '内容数据未能完成备份，未自动修改数据。部分内容暂时无法修改，请检查保存位置的空间和权限后重启重试。',
    };
  }
}
