import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import storeRelease from '../build/store-version.json' with { type: 'json' };

export function storeVersion(override) {
  const version = override || storeRelease.version;
  if (!/^[1-9]\d*\.\d+\.\d+$/.test(version)
      || version.split('.').some(part => Number(part) > 65535)) {
    throw new Error(`Invalid store version: ${version}; expected three numeric components, e.g. 1.0.13`);
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = storeVersion(process.env.STORE_VERSION_OVERRIDE);
  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `STORE_PACKAGE_VERSION=${version}\nMAS_APP_VERSION=${version}\n`);
  }
  console.log(`Store version: ${version}; Windows package: ${version}.0`);
}
