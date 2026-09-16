import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { authFilePath } from './runtime-paths.js';

interface AuthRecord {
  token: string;
  createdAt: string;
}

export async function loadOrCreateControlToken(): Promise<string> {
  const path = authFilePath();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as AuthRecord;
    if (/^[a-f0-9]{64}$/.test(parsed.token)) return parsed.token;
  } catch {
    // A missing or invalid token is replaced atomically for the current user.
  }
  const record: AuthRecord = {
    token: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  return record.token;
}

export async function readControlToken(): Promise<string> {
  const parsed = JSON.parse(await readFile(authFilePath(), 'utf8')) as AuthRecord;
  if (!/^[a-f0-9]{64}$/.test(parsed.token)) throw new Error('控制令牌无效，请重新启动 GEO Publisher');
  return parsed.token;
}
