import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import type { ContentItem } from './content-store.js';
import { evidenceDirectory } from './runtime-paths.js';
import { exportDistributionDiagnosticBundle, sanitizeDiagnosticMessage } from './diagnostic-bundle.js';
import type { ToutiaoContentDiagnostic } from './toutiao-content-diagnostics.js';

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
      evidence: { stage: 'toutiao_preview', url: 'https://mp.toutiao.com/profile_v4/graphic/publish', screenshotPath,
        adDialogObserved: true, adConfirmationClicked: true, adDialogClosed: true, previewObserved: false, confirmationClicked: false,
        toutiaoChecks: [{ phase: 'inspect', adDetection: 'semantic', adDialogVisible: true, adDialogCount: 1,
          adButtonCount: 1, adReadyButtonCount: 0, reason: 'ad_button_unavailable',
          html: 'private-dom', token: 'private-token' }, { reason: 'private-reason' }] },
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
      const steps = { adDialogObserved: true, adConfirmationClicked: true, adDialogClosed: true, previewObserved: false, confirmationClicked: false };
      expect(diagnostic.result).toMatchObject(steps);
      expect(JSON.parse(zip.readAsText('record.json')).payload.evidence).toMatchObject(steps);
      const checks = [{ phase: 'inspect', adDetection: 'semantic', adDialogVisible: true, adDialogCount: 1,
        adButtonCount: 1, adReadyButtonCount: 0, reason: 'ad_button_unavailable' }, {}];
      for (const name of ['diagnostic.json', 'record.json', 'task.json']) {
        const exported = JSON.parse(zip.readAsText(name));
        expect((exported.result || exported.payload.evidence).toutiaoChecks).toEqual(checks);
        expect(zip.readAsText(name)).not.toMatch(/private-(dom|token|reason)/);
      }
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

  it.each(['initial_fill', 'before_publish'] as const)('exports structured Toutiao checks for %s without the compared text', async stage => {
    const root = await mkdtemp(join(tmpdir(), 'geo-toutiao-content-diagnostics-'));
    const previousRoot = process.env.GEO_PUBLISHER_USER_DATA_DIR;
    process.env.GEO_PUBLISHER_USER_DATA_DIR = root;
    let zipPath: string | undefined;
    try {
      const record = failedDistribution('11111111-1111-4111-8111-111111111111', 'failure.png');
      const blocks = { headings: 0, lists: 1, quotes: 0, dividers: 0, images: 0 };
      const diagnostic: ToutiaoContentDiagnostic = { stage, checks: [{
        method: stage === 'initial_fill' ? 'paste' : 'read', writePath: stage === 'initial_fill' ? 'editor_paste' : null,
        titleFound: true, editorFound: true, titleFilled: true, bodyFilled: false, difference: 'missing_text',
        expectedLength: 40, actualLength: 35, mismatchAt: 8, expectedSpanLength: 5, actualSpanLength: 0,
        expectedBlocks: blocks, actualBlocks: blocks,
      }] };
      const input = { ...diagnostic, checks: diagnostic.checks.map(check => ({
        ...check, expectedText: 'private-source', actualText: 'private-readback',
        actualBlocks: { ...check.actualBlocks, rawHtml: 'private-html' },
      })) };
      const code = stage === 'initial_fill' ? 'TOUTIAO_CONTENT_FILL_FAILED' : 'DRAFT_CONTENT_NOT_STABLE';
      if (stage === 'initial_fill') {
        record.payload.error = { code, message: '正文校验失败', details: { toutiaoContent: input } };
        delete record.payload.evidence;
      } else {
        record.status = 'action_required';
        record.payload.evidence = { stage: 'draft_verify', errorCode: code, message: '发布前校验失败', primaryClicked: false, toutiaoContent: input };
        delete record.payload.error;
      }
      zipPath = (await exportDistributionDiagnosticBundle(record, '1.0.23-test')).path;
      const zip = new AdmZip(zipPath);
      expect(JSON.parse(zip.readAsText('diagnostic.json')).failure).toMatchObject({ code, toutiaoContent: diagnostic });
      expect(JSON.parse(zip.readAsText('task.json')).errorCode).toBe(code);
      for (const name of ['record.json', 'task.json']) {
        const { payload } = JSON.parse(zip.readAsText(name));
        const info = stage === 'initial_fill' ? payload.error.details : payload.evidence;
        expect(info.toutiaoContent).toEqual(diagnostic);
      }
      for (const name of ['diagnostic.json', 'record.json', 'task.json']) {
        expect(zip.readAsText(name)).not.toMatch(/private-(source|readback|html)/);
      }
    } finally {
      if (previousRoot === undefined) delete process.env.GEO_PUBLISHER_USER_DATA_DIR;
      else process.env.GEO_PUBLISHER_USER_DATA_DIR = previousRoot;
      if (zipPath) await rm(zipPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
