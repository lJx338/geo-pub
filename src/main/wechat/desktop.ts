import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { ContentItem, ContentStore } from '../content-store.js';
import type { PlatformSessions } from '../platform-sessions.js';
import type { WechatAdapter } from './adapter.js';
import { WechatError, safeWechatError } from './errors.js';
import { wechatCredentialsSchema, wechatProjectIdSchema } from './types.js';

/** Settings stay local; remote platform webviews never receive this IPC capability. */
export function registerWechatDesktopHandlers(dependencies: {
  window: BrowserWindow;
  sessions: PlatformSessions;
  adapter: WechatAdapter;
  content: ContentStore;
  ensureIdle(): void;
  ensureProject(projectId: string): unknown;
  onRecordSaved(record: ContentItem): void;
}): void {
  const { window, sessions, adapter, content } = dependencies;
  const handler = (mutating: boolean, operation: (projectId: string, input: unknown) => Promise<unknown>) =>
    async (event: IpcMainInvokeEvent, rawProjectId: unknown, input: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !event.senderFrame.url.startsWith('file:')) throw new Error('WECHAT_REQUEST_DENIED: 操作来源无效');
      const parsed = wechatProjectIdSchema.safeParse(rawProjectId);
      if (!parsed.success) throw new Error('WECHAT_PROJECT_INVALID: 请选择有效的客户项目');
      dependencies.ensureProject(parsed.data);
      if (mutating) dependencies.ensureIdle();
      try { return await operation(parsed.data, input); }
      catch (error) {
        if (error instanceof Error && /^(PROJECT_CONTEXT_CHANGED|PROJECT_REQUIRED|PUBLISHER_BUSY):/.test(error.message)) throw error;
        const safe = safeWechatError(error);
        throw new Error(`${safe.message}${safe.details.whitelistIp ? `（网络出口 IP：${safe.details.whitelistIp}）` : ''}`);
      }
    };

  ipcMain.handle('geo:wechat-settings', handler(false, (projectId) => adapter.connectionSettings(projectId)));
  ipcMain.handle('geo:wechat-save-credentials', handler(true, async (projectId, input) => {
    const parsed = wechatCredentialsSchema.safeParse(input);
    if (!parsed.success) throw new WechatError('WECHAT_CREDENTIALS_INVALID', '请填写正确的 AppID 和 AppSecret');
    return sessions.runWechatOperation(projectId, async (wechat) => {
      await wechat.saveCredentials(projectId, parsed.data);
      return wechat.connectionSettings(projectId);
    });
  }));
  ipcMain.handle('geo:wechat-test-connection', handler(true, (projectId) => sessions.runWechatOperation(projectId, (wechat) => wechat.testConnection(projectId))));
  ipcMain.handle('geo:wechat-clear-credentials', handler(true, (projectId) => sessions.runWechatOperation(projectId, async (wechat) => {
    await wechat.clearCredentials(projectId);
    return wechat.connectionSettings(projectId);
  })));
  ipcMain.handle('geo:wechat-recheck-draft', handler(true, (projectId, input) => sessions.runWechatOperation(projectId, async (wechat) => {
    const parsed = z.string().min(1).max(120).safeParse(input);
    if (!parsed.success) throw new WechatError('WECHAT_RECORD_INVALID', '分发记录编号不正确');
    const record = (await content.list(projectId, 'distribution')).find((item) => item.id === parsed.data && item.platform === 'wechat');
    const evidence = record?.payload.evidence as Record<string, unknown> | undefined;
    if (!record || typeof evidence?.operationKey !== 'string') throw new WechatError('WECHAT_RECORD_NOT_FOUND', '这条分发记录没有可核对的微信草稿');
    const result = await wechat.recheckDraft(projectId, evidence.operationKey);
    const saved = await content.save(projectId, {
      id: record.id, kind: 'distribution', platform: 'wechat', status: result.verified ? 'filled' : result.status,
      payload: { ...record.payload, completedAt: new Date().toISOString(), evidence: result, error: undefined, diagnosticPath: undefined },
    });
    dependencies.onRecordSaved(saved);
    return { record: saved };
  })));
}
