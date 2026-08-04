import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { controlEndpoint, discoveryFilePath } from './runtime-paths.js';

export interface DiscoveryRecord {
  schemaVersion: 1;
  appVersion: string;
  cliPath: string | null;
  controlEndpoint: string;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  ready: boolean;
  updatedAt: string;
}

export function createDiscoveryRecord(appVersion: string, cliPath: string | null, ready: boolean): DiscoveryRecord {
  return {
    schemaVersion: 1,
    appVersion,
    cliPath,
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
