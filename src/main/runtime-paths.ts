import { createHash, randomUUID } from 'node:crypto';
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

export function diagnosticsDirectory(): string {
  return join(dataDirectory(), 'diagnostics');
}

export function discoveryFilePath(): string {
  return join(dataDirectory(), 'discovery.json');
}

export function cliDirectory(): string {
  return join(dataDirectory(), 'bin');
}

export function cliLauncherPath(): string {
  return join(cliDirectory(), process.platform === 'win32' ? 'geo-publisher.exe' : 'geo-publisher');
}

export function coreCliPath(version: string): string {
  return join(cliDirectory(), 'versions', version, process.platform === 'win32' ? 'geo-publisher-core.exe' : 'geo-publisher-core');
}

/** @deprecated Use cliLauncherPath() for external callers or coreCliPath() internally. */
export function cliExecutablePath(version?: string): string {
  return version ? coreCliPath(version) : cliLauncherPath();
}

export function integrationsDirectory(): string {
  return join(dataDirectory(), 'integrations');
}

export function controlEndpoint(): string {
  const userKey = createHash('sha256').update(homedir()).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\geo-publisher-${userKey}`;
  return `/tmp/geo-publisher-${userKey}.sock`;
}

export function workerEndpoint(): string {
  const userKey = createHash('sha256').update(homedir()).digest('hex').slice(0, 12);
  const instanceKey = randomUUID().replace(/-/g, '');
  if (process.platform === 'win32') return `\\\\.\\pipe\\geo-publisher-worker-${userKey}-${instanceKey}`;
  return `/tmp/geo-publisher-worker-${userKey}-${instanceKey}.sock`;
}
