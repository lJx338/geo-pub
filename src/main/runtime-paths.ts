import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDirectory(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'GEO Publisher Desktop');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'GEO Publisher Desktop');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'geo-publisher');
}

export function authFilePath(): string {
  return join(dataDirectory(), 'control-token.json');
}

export function evidenceDirectory(): string {
  return join(dataDirectory(), 'evidence');
}

export function controlEndpoint(): string {
  const userKey = createHash('sha256').update(homedir()).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\geo-publisher-${userKey}`;
  return `/tmp/geo-publisher-${userKey}.sock`;
}
