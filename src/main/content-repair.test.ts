import { mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { repairContentReusePolicies } from './content-repair.js';

function fixture(policies: SQLInputValue[]) {
  const directory = mkdtempSync(join(tmpdir(), 'geo-content-repair-'));
  const path = join(directory, 'content.sqlite3');
  const backups = join(directory, 'backups');
  const database = new DatabaseSync(path);
  // A legacy/imported table can contain NULL even though the current schema
  // forbids it. Other data and schema objects must survive the backup intact.
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE content_items (id TEXT PRIMARY KEY, reuse_policy, title TEXT, payload TEXT, updated_at TEXT);
    CREATE INDEX idx_title ON content_items(title);
    CREATE TABLE unrelated (value TEXT);
    INSERT INTO unrelated VALUES ('keep me');`);
  for (const [index, policy] of policies.entries()) {
    database.prepare('INSERT INTO content_items VALUES (?, ?, ?, ?, ?)').run(String(index), policy, `title-${index}`, '{"body":"keep this article"}', '2026-10-13T00:00:00.000Z');
  }
  const rows = () => database.prepare('SELECT * FROM content_items ORDER BY id').all();
  const repair = () => repairContentReusePolicies(database, path, backups);
  return { directory, path, backups, database, rows, repair };
}

describe('content reuse policy repair', () => {
  it('backs up committed WAL data and changes only invalid policies, with an atomic audit log', () => {
    const f = fixture(['standard', 'evergreen', ' STANDARD ', ' Evergreen\t', '', null, 'unknown', 42, new Uint8Array([1, 2])]);
    const before = f.rows();
    try {
      expect(existsSync(`${f.path}-wal`)).toBe(true);
      const result = f.repair();
      expect(result).toMatchObject({ status: 'repaired', repairedCount: 7 });
      const backup = new DatabaseSync(result!.backupPath!, { readOnly: true });
      try {
        expect(backup.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
        expect(backup.prepare('SELECT * FROM content_items ORDER BY id').all()).toEqual(before);
        expect(backup.prepare('SELECT * FROM unrelated').all()).toEqual([{ value: 'keep me' }]);
        expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_title'").get()).toBeTruthy();
      } finally { backup.close(); }
      expect(f.rows()).toEqual(before.map((row, index) => ({ ...row, reuse_policy: [1, 3].includes(index) ? 'evergreen' : 'standard' })));
      const log = f.database.prepare('SELECT content_id, old_reuse_policy, new_reuse_policy, backup_path FROM content_repair_log ORDER BY content_id').all();
      expect(log).toEqual(before.slice(2).map((row, index) => ({ content_id: row.id, old_reuse_policy: row.reuse_policy, new_reuse_policy: index === 1 ? 'evergreen' : 'standard', backup_path: result!.backupPath })));
      expect(f.repair()).toBeNull();
      expect(readdirSync(f.backups)).toHaveLength(1);
    } finally { f.database.close(); }
  });

  it('does not create backups or logs when all records are valid', () => {
    const f = fixture(['standard', 'evergreen']);
    try {
      expect(f.repair()).toBeNull();
      expect(existsSync(f.backups)).toBe(false);
      expect(f.database.prepare("SELECT name FROM sqlite_master WHERE name = 'content_repair_log'").get()).toBeUndefined();
    } finally { f.database.close(); }
  });

  it('leaves every original value untouched when the backup cannot be created', () => {
    const f = fixture(['', ' EVERGREEN ']);
    writeFileSync(f.backups, 'a file prevents creating the backup directory');
    const before = f.rows();
    try {
      expect(f.repair()).toMatchObject({ status: 'failed', repairedCount: 0, backupPath: undefined });
      expect(f.rows()).toEqual(before);
      expect(f.database.prepare("SELECT name FROM sqlite_master WHERE name = 'content_repair_log'").get()).toBeUndefined();
      // The failed repair released its transaction/lock.
      f.database.exec('BEGIN IMMEDIATE; ROLLBACK');
    } finally { f.database.close(); }
  });

  it('rolls back all corrections when an update fails and retains the usable backup', () => {
    const f = fixture(['', 'unknown']);
    f.database.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON content_items WHEN OLD.id = '1' BEGIN SELECT RAISE(ABORT, 'test repair failure'); END");
    const before = f.rows();
    try {
      const result = f.repair();
      expect(result).toMatchObject({ status: 'failed', repairedCount: 0 });
      expect(result?.backupPath).toBeTruthy();
      expect(f.rows()).toEqual(before);
      const backup = new DatabaseSync(result!.backupPath!, { readOnly: true });
      try { expect(backup.prepare('SELECT * FROM content_items ORDER BY id').all()).toEqual(before); }
      finally { backup.close(); }
      expect(f.database.prepare("SELECT name FROM sqlite_master WHERE name = 'content_repair_log'").get()).toBeUndefined();
    } finally { f.database.close(); }
  });
});
