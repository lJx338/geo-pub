import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import type { ContentItem } from './content-store.js';
import { evidenceDirectory } from './runtime-paths.js';
import { exportDistributionDiagnosticBundle, sanitizeDiagnosticMessage } from './diagnostic-bundle.js';

function failedDistribution(projectId: string, screenshotPath: string): ContentItem {
  const timestamp = new Date().toISOString();
  return {
    id: 'distribution-diagnostic-test',
    projectId,
    kind: 'distribution',
    title: '测试文章',
    status: 'failed',
    platform: 'toutiao',
    category: '',
    topicFamilyId: '',
    parentTopicId: '',
    variantNumber: 1,
    usageCount: 0,
    lastUsedAt: null,
    reusePolicy: 'standard',
    cooldownDays: 0,
    reservedBy: '',
    reservedUntil: null,
    payload: {
      taskId: 'task-diagnostic-test',
      articleId: 'article-diagnostic-test',
      mode: 'publish',
      startedAt: timestamp,
      completedAt: timestamp,
      evidence: { stage: 'result_check', url: 'https://mp.toutiao.com/profile_v4/graphic/articles', screenshotPath },
      error: {
        code: 'TOUTIAO_RESULT_UNCERTAIN',
        message: '页面失败 token=secret-token，正文：不应进入诊断包',
        details: { screenshotPath },
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('distribution diagnostic bundles', () => {
  it('redacts credentials and local paths from diagnostic messages', () => {
    expect(sanitizeDiagnosticMessage('GET ?token=secret&x=1 C:\\Users\\demo\\file.txt')).toContain('token: [REDACTED]');
    expect(sanitizeDiagnosticMessage('GET ?token=secret&x=1 C:\\Users\\demo\\file.txt')).toContain('[LOCAL_PATH]');
  });

  it('exports a ZIP containing the record, diagnostic JSON, and evidence screenshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'geo-publisher-diagnostic-test-'));
    const previousRoot = process.env.GEO_PUBLISHER_USER_DATA_DIR;
    process.env.GEO_PUBLISHER_USER_DATA_DIR = root;
    const projectId = '11111111-1111-4111-8111-111111111111';
    const screenshotDirectory = join(evidenceDirectory(projectId), '2026-09-29');
    const screenshotPath = join(screenshotDirectory, 'failure.png');
    try {
      await mkdir(screenshotDirectory, { recursive: true });
      await writeFile(screenshotPath, Buffer.from('png-test'));
      const bundle = await exportDistributionDiagnosticBundle(failedDistribution(projectId, screenshotPath), '0.6.0-test');
      const zip = new AdmZip(bundle.path);
      const names = zip.getEntries().map((entry) => entry.entryName);
      expect(names).toEqual(expect.arrayContaining(['record.json', 'task.json', 'diagnostic.json', 'evidence/failure.png']));
      expect(zip.readAsText('record.json')).not.toContain('secret-token');
      expect(zip.readAsText('record.json')).not.toContain('不应进入诊断包');
      const diagnostic = JSON.parse(zip.readAsText('diagnostic.json')) as Record<string, unknown>;
      expect(JSON.stringify(diagnostic)).not.toContain('secret-token');
      expect(JSON.stringify(diagnostic)).not.toContain('不应进入诊断包');
      expect(zip.readFile('evidence/failure.png')?.toString()).toBe('png-test');
      await rm(bundle.path, { force: true });
      await expect(readFile(bundle.path)).rejects.toThrow();
    } finally {
      if (previousRoot === undefined) delete process.env.GEO_PUBLISHER_USER_DATA_DIR;
      else process.env.GEO_PUBLISHER_USER_DATA_DIR = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});
