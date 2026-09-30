import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';
import type { ContentItem } from './content-store.js';
import { diagnosticsDirectory, evidenceDirectory } from './runtime-paths.js';

const diagnosticExportDirectory = join(tmpdir(), 'geo-publisher-diagnostic-exports');

export function sanitizeDiagnosticMessage(value: string): string {
  return String(value || '')
    .replace(/([?&](?:token|access_token|auth|authorization|session|cookie|code)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:bearer\s+)[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|accessToken|authorization|cookie|sessionId)\s*[:=]\s*["']?[^\s,"'}]+/gi, '$1: [REDACTED]')
    .replace(/\b[A-Za-z]:\\(?:[^\s,;]+\\)*[^\s,;]+/g, '[LOCAL_PATH]')
    .replace(/\/(?:Users|home|var|tmp)\/[^\s,;]+/g, '[LOCAL_PATH]')
    .slice(0, 2_000);
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function isWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = `${resolve(root)}${sep}`;
  return resolvedPath.startsWith(resolvedRoot);
}

function payloadRecord(record: ContentItem): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

function evidencePaths(record: ContentItem): string[] {
  const payload = payloadRecord(record);
  const evidence = payload.evidence && typeof payload.evidence === 'object' ? payload.evidence as Record<string, unknown> : {};
  const error = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  return [...new Set([
    evidence.screenshotPath,
    evidence.settingsScreenshotPath,
    evidence.coverScreenshotPath,
    details.screenshotPath,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function safeUrl(value: unknown): string | null {
  return typeof value === 'string' && value ? (value.split('?')[0] || value) : null;
}

function safeEvidence(record: ContentItem): Record<string, unknown> {
  const payload = payloadRecord(record);
  const evidence = payload.evidence && typeof payload.evidence === 'object' ? payload.evidence as Record<string, unknown> : {};
  return {
    stage: typeof evidence.stage === 'string' ? evidence.stage : null,
    message: typeof evidence.message === 'string' ? sanitizeDiagnosticMessage(evidence.message) : null,
    errorCode: typeof evidence.errorCode === 'string' ? evidence.errorCode : null,
    url: safeUrl(evidence.url),
    primaryClicked: evidence.primaryClicked ?? null,
    confirmationClicked: evidence.confirmationClicked ?? null,
    screenshotFile: typeof evidence.screenshotPath === 'string' ? basename(evidence.screenshotPath) : null,
    settingsScreenshotFile: typeof evidence.settingsScreenshotPath === 'string' ? basename(evidence.settingsScreenshotPath) : null,
    coverScreenshotFile: typeof evidence.coverScreenshotPath === 'string' ? basename(evidence.coverScreenshotPath) : null,
  };
}

function safeError(record: ContentItem): Record<string, unknown> {
  const payload = payloadRecord(record);
  const error = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  return {
    code: typeof error.code === 'string' ? error.code : null,
    message: typeof error.message === 'string' ? sanitizeDiagnosticMessage(error.message) : null,
    details: {
      platform: typeof details.platform === 'string' ? details.platform : null,
      pageTitle: typeof details.pageTitle === 'string' ? sanitizeDiagnosticMessage(details.pageTitle) : null,
      url: safeUrl(details.url),
      screenshotFile: typeof details.screenshotPath === 'string' ? basename(details.screenshotPath) : null,
    },
  };
}

function safeRecord(record: ContentItem): Record<string, unknown> {
  const payload = payloadRecord(record);
  return {
    id: record.id,
    projectId: record.projectId,
    platform: record.platform,
    status: record.status,
    titleFingerprint: fingerprint(record.title || ''),
    payload: {
      taskId: typeof payload.taskId === 'string' ? payload.taskId : null,
      articleId: typeof payload.articleId === 'string' ? payload.articleId : null,
      mode: typeof payload.mode === 'string' ? payload.mode : null,
      startedAt: typeof payload.startedAt === 'string' ? payload.startedAt : null,
      completedAt: typeof payload.completedAt === 'string' ? payload.completedAt : null,
      evidence: safeEvidence(record),
      error: safeError(record),
    },
  };
}

function diagnosticData(record: ContentItem, version: string): Record<string, unknown> {
  const payload = payloadRecord(record);
  const evidence = payload.evidence && typeof payload.evidence === 'object' ? payload.evidence as Record<string, unknown> : {};
  const error = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const message = typeof error.message === 'string'
    ? error.message
    : typeof evidence.message === 'string' ? evidence.message : '';
  const code = typeof error.code === 'string'
    ? error.code
    : typeof evidence.errorCode === 'string' ? evidence.errorCode : null;
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    app: { version, platform: process.platform, arch: process.arch, electron: process.versions.electron },
    task: {
      recordId: record.id,
      taskId: typeof payload.taskId === 'string' ? payload.taskId : null,
      projectId: record.projectId,
      platform: record.platform,
      mode: typeof payload.mode === 'string' ? payload.mode : null,
      status: record.status,
      titleFingerprint: fingerprint(record.title || ''),
      startedAt: typeof payload.startedAt === 'string' ? payload.startedAt : null,
      completedAt: typeof payload.completedAt === 'string' ? payload.completedAt : null,
    },
    result: {
      stage: typeof evidence.stage === 'string' ? evidence.stage : null,
      message: typeof evidence.message === 'string' ? sanitizeDiagnosticMessage(evidence.message) : null,
      url: typeof evidence.url === 'string' ? evidence.url.split('?')[0] : typeof details.url === 'string' ? details.url.split('?')[0] : null,
      primaryClicked: evidence.primaryClicked ?? null,
      confirmationClicked: evidence.confirmationClicked ?? null,
    },
    failure: { code, message: sanitizeDiagnosticMessage(message) },
    evidenceFiles: evidencePaths(record).map((path) => basename(path)),
    privacy: '诊断包不包含 Cookie、Token、localStorage、sessionStorage 或文章正文；页面截图可能显示当前可见平台页面。',
  };
}

export async function writeDistributionDiagnostic(record: ContentItem, version: string): Promise<string> {
  const directory = diagnosticsDirectory(record.projectId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${record.id}.json`);
  await writeFile(path, JSON.stringify(diagnosticData(record, version), null, 2), { mode: 0o600 });
  return path;
}

export async function exportDistributionDiagnosticBundle(record: ContentItem, version: string): Promise<{ path: string; fileName: string }> {
  const payload = payloadRecord(record);
  const storedPath = typeof payload.diagnosticPath === 'string' ? payload.diagnosticPath : '';
  const diagnosticPath = storedPath && isWithin(storedPath, diagnosticsDirectory(record.projectId))
    ? storedPath
    : await writeDistributionDiagnostic(record, version);
  const zip = new AdmZip();
  const safe = safeRecord(record);
  zip.addFile('record.json', Buffer.from(JSON.stringify(safe, null, 2)));
  // Keep the legacy file name so support tooling from the previous release can
  // open a bundle without knowing about the project-scoped record model.
  zip.addFile('task.json', Buffer.from(JSON.stringify({
    taskId: payload.taskId || record.id,
    platform: record.platform,
    status: record.status,
    errorCode: (safe.payload as Record<string, unknown>).error && ((safe.payload as Record<string, unknown>).error as Record<string, unknown>).code,
    titleFingerprint: safe.titleFingerprint,
    payload: safe.payload,
  }, null, 2)));
  zip.addFile('diagnostic.json', await readFile(diagnosticPath));

  const evidenceRoot = evidenceDirectory(record.projectId);
  for (const path of evidencePaths(record)) {
    if (!isWithin(path, evidenceRoot)) continue;
    try { zip.addFile(`evidence/${basename(path)}`, await readFile(path)); } catch { /* Screenshots are best effort. */ }
  }

  await mkdir(diagnosticExportDirectory, { recursive: true });
  const fileName = `GEO-Publisher-${record.platform}-${record.id.slice(0, 8)}-diagnostic.zip`;
  const path = join(diagnosticExportDirectory, `${Date.now()}-${fileName}`);
  await new Promise<void>((resolveWrite, rejectWrite) => zip.writeZip(path, (error) => error ? rejectWrite(error) : resolveWrite()));
  return { path, fileName };
}
