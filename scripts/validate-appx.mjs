import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

const releaseDirectory = path.resolve(process.argv[2] || 'release/store');
const requestedVersion = process.argv[3] || process.env.STORE_PACKAGE_VERSION || '1.0.0';
const expectedVersion = normalizeVersion(requestedVersion);
const expectedIdentity = '78707CBF.LingxiWorkspace';
const expectedPublisher = 'CN=5C62BC82-3986-4D37-81C4-0EAF060A1A5D';
const expectedPublisherDisplayName = '灵犀科技';
const expectedApplicationId = 'LingxiWorkspace';
const requiredAssets = new Map([
  ['storelogo.png', [50, 50]],
  ['square150x150logo.png', [150, 150]],
  ['square44x44logo.png', [44, 44]],
  ['wide310x150logo.png', [310, 150]],
]);

const files = (await readdir(releaseDirectory)).filter((file) => /\.(?:appx|msix)$/i.test(file));
if (files.length !== 1) {
  throw new Error(`应当在 ${releaseDirectory} 找到一个 MSIX/AppX 包，实际找到 ${files.length} 个`);
}

const packagePath = path.join(releaseDirectory, files[0]);
const zip = new AdmZip(packagePath);
const manifestEntry = zip.getEntries().find((entry) => entry.entryName.toLowerCase() === 'appxmanifest.xml');
if (!manifestEntry) throw new Error('包中缺少 AppxManifest.xml');

const manifest = manifestEntry.getData().toString('utf8');
const identity = getElement(manifest, 'Identity');
const properties = getElement(manifest, 'Properties');
const application = getElement(manifest, 'Application');

assertEqual(getAttribute(identity, 'Name'), expectedIdentity, 'Identity.Name');
assertEqual(getAttribute(identity, 'Publisher'), expectedPublisher, 'Identity.Publisher');
assertEqual(getAttribute(identity, 'Version'), expectedVersion, 'Identity.Version');
assertEqual(getElementText(properties, 'PublisherDisplayName'), expectedPublisherDisplayName, 'PublisherDisplayName');
assertEqual(getAttribute(application, 'Id'), expectedApplicationId, 'Application.Id');

const displayName = getElementText(properties, 'DisplayName');
if (displayName !== 'Lingxi Workspace') {
  throw new Error(`Properties.DisplayName 应为 Lingxi Workspace，实际为 ${displayName || '(空)'}`);
}

for (const [assetName, dimensions] of requiredAssets) {
  const entry = zip.getEntries().find((candidate) => candidate.entryName.toLowerCase() === `assets/${assetName}`);
  if (!entry) throw new Error(`包中缺少商店资源 assets/${assetName}`);
  const actual = pngDimensions(entry.getData());
  if (actual[0] !== dimensions[0] || actual[1] !== dimensions[1]) {
    throw new Error(`assets/${assetName} 尺寸应为 ${dimensions.join('x')}，实际为 ${actual.join('x')}`);
  }
}

console.log(`MSIX 验证通过：${packagePath}`);
console.log(`身份：${expectedIdentity}`);
console.log(`版本：${expectedVersion}`);
console.log('商店图标：StoreLogo、Square150x150Logo、Square44x44Logo、Wide310x150Logo');

function normalizeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.0)?$/.exec(String(value));
  if (!match) throw new Error(`商店版本必须是 1.0.0 或 1.0.0.0：${value}`);
  const parts = match.slice(1, 4).map(Number);
  if (parts[0] < 1 || parts.some((part) => part > 65535)) {
    throw new Error(`商店版本无效：${value}`);
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

function getElement(xml, name) {
  const match = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'i').exec(xml)
    || new RegExp(`<${name}\\b[^>]*\\/>`, 'i').exec(xml);
  if (!match) throw new Error(`Manifest 中缺少 ${name}`);
  return match[0];
}

function getAttribute(element, name) {
  const match = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(element);
  return match?.[2] || '';
}

function getElementText(xml, name) {
  const match = new RegExp(`<${name}\\b[^>]*>(.*?)</${name}>`, 'is').exec(xml);
  return match?.[1]?.trim() || '';
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} 应为 ${expected}，实际为 ${actual || '(空)'}`);
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('资源不是有效 PNG');
  }
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}
