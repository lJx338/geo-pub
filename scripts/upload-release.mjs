import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import COS from 'cos-nodejs-sdk-v5';
import { parse } from 'yaml';
import { renderChannelManifest } from './render-channel-manifest.mjs';

const [directory, target, channel] = process.argv.slice(2);
if (!directory || !target || !channel) {
  throw new Error('Usage: node scripts/upload-release.mjs <directory> <target> <channel>');
}
if (!['win-x64', 'mac-arm64'].includes(target)) throw new Error(`Unsupported target: ${target}`);
if (!['stable', 'beta'].includes(channel)) throw new Error(`Unsupported channel: ${channel}`);

const requiredEnvironment = [
  'TENCENT_CLOUD_SECRET_ID',
  'TENCENT_CLOUD_SECRET_KEY',
  'TENCENT_COS_BUCKET',
  'TENCENT_COS_REGION',
];
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

const bucket = process.env.TENCENT_COS_BUCKET;
const region = process.env.TENCENT_COS_REGION;
const prefix = process.env.TENCENT_COS_PREFIX || 'geo-publisher';
const publicBase =
  process.env.GEO_UPDATE_PUBLIC_BASE ||
  `https://${bucket}.cos.${region}.myqcloud.com/${prefix}/releases`;

const cos = new COS({
  SecretId: process.env.TENCENT_CLOUD_SECRET_ID,
  SecretKey: process.env.TENCENT_CLOUD_SECRET_KEY,
  ChunkSize: 8 * 1024 * 1024,
  SliceSize: 8 * 1024 * 1024,
  ChunkParallelLimit: 8,
  ChunkRetryTimes: 5,
  FileParallelLimit: 1,
  Timeout: 120_000,
  KeepAlive: true,
});

const manifestName =
  target === 'mac-arm64'
    ? channel === 'beta'
      ? 'beta-mac.yml'
      : 'latest-mac.yml'
    : channel === 'beta'
      ? 'beta.yml'
      : 'latest.yml';
const manifestPath = path.join(directory, manifestName);
const sourceManifest = await readFile(manifestPath, 'utf8');
const parsedManifest = parse(sourceManifest);
const version = parsedManifest?.version;
if (typeof version !== 'string' || !version) throw new Error('Update manifest has no version');

const versionKey = `${prefix}/releases/versions/${version}/${target}`;
const versionUrl = `${publicBase}/versions/${version}/${target}`;
const immutableCache = 'public, max-age=31536000, immutable';
const channelCache = 'no-cache, no-store, must-revalidate';
const artifactExtensions = new Set(['.exe', '.dmg', '.zip', '.blockmap']);

const artifactNames = (await readdir(directory))
  .filter((name) => artifactExtensions.has(path.extname(name)))
  .sort();
if (artifactNames.length === 0) throw new Error(`No release artifact found for ${target}`);

function describeError(error) {
  return error?.code || error?.message || String(error);
}

async function retry(label, operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = attempt * 5_000;
      console.warn(`${label} failed (${describeError(error)}), retrying in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function uploadFile(filePath, key, cacheControl) {
  const size = (await stat(filePath)).size;
  let lastReported = -1;
  console.log(`Uploading ${path.basename(filePath)} (${Math.ceil(size / 1024 / 1024)} MiB)`);
  await retry(`Upload ${key}`, () =>
    cos.uploadFile({
      Bucket: bucket,
      Region: region,
      Key: key,
      FilePath: filePath,
      CacheControl: cacheControl,
      SliceSize: 8 * 1024 * 1024,
      onProgress(progress) {
        const percent = Math.floor((progress.percent || 0) * 10) * 10;
        if (percent !== lastReported) {
          lastReported = percent;
          console.log(`${path.basename(filePath)}: ${percent}%`);
        }
      },
    }),
  );
}

async function putManifest(key, body, cacheControl) {
  await retry(`Upload ${key}`, () =>
    cos.putObject({
      Bucket: bucket,
      Region: region,
      Key: key,
      Body: body,
      ContentType: 'application/x-yaml',
      CacheControl: cacheControl,
    }),
  );
}

async function verifyObject(key, expectedSize) {
  const result = await retry(`Verify ${key}`, () =>
    cos.headObject({ Bucket: bucket, Region: region, Key: key }),
  );
  const actualSize = Number(result.headers?.['content-length']);
  if (Number.isFinite(expectedSize) && actualSize !== expectedSize) {
    throw new Error(`Uploaded size mismatch for ${key}: expected ${expectedSize}, got ${actualSize}`);
  }
}

for (const artifactName of artifactNames) {
  const filePath = path.join(directory, artifactName);
  const key = `${versionKey}/${artifactName}`;
  const size = (await stat(filePath)).size;
  await uploadFile(filePath, key, immutableCache);
  await verifyObject(key, size);
}

const renderedManifest = renderChannelManifest(sourceManifest, versionUrl);
await putManifest(`${versionKey}/${manifestName}`, renderedManifest, immutableCache);

// Publish the channel pointer only after every referenced artifact is present.
for (const file of parse(renderedManifest).files) {
  const artifactName = decodeURIComponent(new URL(file.url).pathname.split('/').at(-1));
  const filePath = path.join(directory, artifactName);
  await verifyObject(`${versionKey}/${artifactName}`, (await stat(filePath)).size);
}

await putManifest(
  `${prefix}/releases/channels/${channel}/${target}/${manifestName}`,
  renderedManifest,
  channelCache,
);

if (channel === 'stable') {
  const compatibilityManifest = target === 'mac-arm64' ? 'stable-mac.yml' : 'stable.yml';
  const legacyBetaManifest = target === 'mac-arm64' ? 'beta-mac.yml' : 'beta.yml';
  const compatibilityKeys = [
    `${prefix}/releases/channels/stable/${target}/${compatibilityManifest}`,
    `${prefix}/releases/stable/${target}/${manifestName}`,
    `${prefix}/releases/stable/${target}/${compatibilityManifest}`,
    `${prefix}/releases/beta/${target}/${legacyBetaManifest}`,
  ];
  for (const key of compatibilityKeys) await putManifest(key, renderedManifest, channelCache);
}

console.log(`Published ${target} ${version} to the ${channel} channel`);
