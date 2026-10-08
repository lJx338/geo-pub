import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

let sandboxUserData: string | undefined;
let activeControlEndpoint: string | undefined;

export function isMacAppStoreRuntime(): boolean {
  return process.platform === 'darwin' && process.mas === true;
}

/** Call before constructing stores. The path must come from Electron, not a guessed container name. */
export function configureSandboxUserData(path: string): void {
  sandboxUserData = path;
}

export function setActiveControlEndpoint(endpoint: string | undefined): void {
  activeControlEndpoint = endpoint;
}

export function dataDirectory(): string {
  if (isMacAppStoreRuntime()) {
    if (!sandboxUserData) throw new Error('Mac App Store data directory has not been initialized');
    return sandboxUserData;
  }
  if (process.env.GEO_PUBLISHER_USER_DATA_DIR) return process.env.GEO_PUBLISHER_USER_DATA_DIR;
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

export function evidenceDirectory(projectId?: string): string {
  return projectId ? join(dataDirectory(), 'projects', projectId, 'evidence') : join(dataDirectory(), 'evidence');
}

export function diagnosticsDirectory(projectId?: string): string {
  return projectId ? join(dataDirectory(), 'projects', projectId, 'diagnostics') : join(dataDirectory(), 'diagnostics');
}

export function discoveryFilePath(): string {
  return join(dataDirectory(), 'discovery.json');
}

export function cliDirectory(): string {
  return join(dataDirectory(), 'bin');
}

export function cliExecutablePath(version?: string): string {
  if (process.platform === 'win32' && version) return join(cliDirectory(), 'versions', version, 'geo-publisher.exe');
  return join(cliDirectory(), process.platform === 'win32' ? 'geo-publisher.exe' : 'geo-publisher');
}

export function integrationsDirectory(): string {
  return join(dataDirectory(), 'integrations');
}

export function controlEndpoint(): string {
  if (isMacAppStoreRuntime()) return activeControlEndpoint || 'tcp://127.0.0.1:0';
  if (process.env.GEO_PUBLISHER_CONTROL_ENDPOINT) return process.env.GEO_PUBLISHER_CONTROL_ENDPOINT;
  const userKey = createHash('sha256').update(homedir()).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\geo-publisher-${userKey}`;
  return `/tmp/geo-publisher-${userKey}.sock`;
}
