import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { controlEndpoint, discoveryFilePath } from './runtime-paths.js';
import { CONTROL_CAPABILITIES, CONTROL_PROTOCOL_VERSION } from '../shared/protocol.js';

export interface InstalledCliPaths {
  launcherPath: string | null;
  coreCliPath: string | null;
}

export interface DiscoveryRecord {
  schemaVersion: 3;
  appVersion: string;
  cliVersion: string;
  protocolVersion: number;
  capabilities: string[];
  skillVersion: string;
  appPath: string;
  launcherPath: string | null;
  coreCliPath: string | null;
  /** Kept for older Skills; always points to the fixed launcher. */
  cliPath: string | null;
  controlEndpoint: string;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  ready: boolean;
  updatedAt: string;
}

export function createDiscoveryRecord(appVersion: string, cli: InstalledCliPaths, ready: boolean): DiscoveryRecord {
  return {
    schemaVersion: 3,
    appVersion,
    cliVersion: appVersion,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    capabilities: [...CONTROL_CAPABILITIES],
    skillVersion: appVersion,
    appPath: process.execPath,
    launcherPath: cli.launcherPath,
    coreCliPath: cli.coreCliPath,
    cliPath: cli.launcherPath,
    controlEndpoint: controlEndpoint(),
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    ready,
    updatedAt: new Date().toISOString(),
  };
}

export async function writeDiscoveryRecord(record: DiscoveryRecord): Promise<string> {
  const path = discoveryFilePath();
  const temporary = `${path}.new`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
  return path;
}
