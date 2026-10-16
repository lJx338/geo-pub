import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { WechatError } from './errors.js';
import { wechatArticleSchema, wechatCredentialsSchema, wechatProjectIdSchema, type WechatCredentials } from './types.js';

export interface WechatCipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export const operationSchema = z.object({
  version: z.literal(1), projectId: wechatProjectIdSchema,
  key: z.string().regex(/^[a-f0-9]{64}$/), appId: wechatCredentialsSchema.shape.appId,
  title: z.string(), state: z.enum(['prepared', 'submitting', 'created', 'verified', 'uncertain', 'failed']),
  article: wechatArticleSchema.optional(), mediaId: z.string().min(1).optional(),
  errorCode: z.string().optional(), message: z.string().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type WechatOperation = z.infer<typeof operationSchema>;

export function requireWechatProjectId(value: string): string {
  const result = wechatProjectIdSchema.safeParse(value);
  if (!result.success) throw new WechatError('WECHAT_PROJECT_INVALID', '请先选择有效的客户项目');
  return result.data;
}

function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function atomicWrite(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

/** Only this add-on's files are written. Credentials never fall back to plaintext. */
export class WechatStore {
  constructor(readonly root: string, private readonly cipher: WechatCipher) {}

  projectDirectory(projectId: string): string {
    return join(this.root, 'projects', requireWechatProjectId(projectId), 'wechat');
  }

  private requireCipher(): void {
    if (!this.cipher.available()) throw new WechatError('WECHAT_ENCRYPTION_UNAVAILABLE', '电脑的安全存储不可用，暂时无法保存或读取 AppSecret');
  }

  async saveCredentials(projectId: string, credentials: WechatCredentials): Promise<void> {
    const id = requireWechatProjectId(projectId);
    const parsed = wechatCredentialsSchema.safeParse(credentials);
    if (!parsed.success) throw new WechatError('WECHAT_CREDENTIALS_INVALID', '请填写正确的 AppID 和 AppSecret');
    this.requireCipher();
    await atomicWrite(join(this.projectDirectory(id), 'credentials.bin'),
      this.cipher.encrypt(JSON.stringify({ version: 1, projectId: id, ...parsed.data })));
  }

  async readCredentials(projectId: string): Promise<WechatCredentials | null> {
    const id = requireWechatProjectId(projectId);
    let bytes: Buffer;
    try { bytes = await readFile(join(this.projectDirectory(id), 'credentials.bin')); }
    catch (error) { if (missing(error)) return null; throw error; }
    this.requireCipher();
    try {
      const value = z.object({ version: z.literal(1), projectId: wechatProjectIdSchema, ...wechatCredentialsSchema.shape })
        .parse(JSON.parse(this.cipher.decrypt(bytes)));
      if (value.projectId !== id) throw new Error('Wrong credential owner');
      return { appId: value.appId, appSecret: value.appSecret };
    } catch { throw new WechatError('WECHAT_CREDENTIALS_UNREADABLE', '本项目的公众号连接信息无法解密，请重新填写'); }
  }

  async clearCredentials(projectId: string): Promise<void> {
    await rm(join(this.projectDirectory(projectId), 'credentials.bin'), { force: true });
  }

  private recordPath(projectId: string, key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new WechatError('WECHAT_RECORD_INVALID', '草稿记录编号不正确');
    return join(this.projectDirectory(projectId), 'records', `${key}.json`);
  }

  async readOperation(projectId: string, key: string): Promise<WechatOperation | null> {
    let value: string;
    try { value = await readFile(this.recordPath(projectId, key), 'utf8'); }
    catch (error) { if (missing(error)) return null; throw error; }
    try {
      const record = operationSchema.parse(JSON.parse(value));
      if (record.projectId !== requireWechatProjectId(projectId) || record.key !== key) throw new Error('Wrong record owner');
      return record;
    } catch { throw new WechatError('WECHAT_RECORD_INVALID', '草稿记录损坏，已停止提交以避免重复创建'); }
  }

  async saveOperation(record: WechatOperation): Promise<void> {
    const parsed = operationSchema.parse(record);
    await atomicWrite(this.recordPath(parsed.projectId, parsed.key), JSON.stringify(parsed, null, 2));
  }

  async listOperations(projectId: string): Promise<WechatOperation[]> {
    let names: string[];
    try { names = await readdir(join(this.projectDirectory(projectId), 'records')); }
    catch (error) { if (missing(error)) return []; throw error; }
    const records = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => this.readOperation(projectId, name.slice(0, -5))));
    return records.filter((record): record is WechatOperation => record !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Exclusive across instances/processes, including credential changes during a write. */
  async exclusive<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const path = join(this.projectDirectory(projectId), 'operation.lock');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new WechatError('WECHAT_BUSY', '该项目正在处理公众号任务；若上次异常退出，请关闭测试窗口后按说明清理任务锁');
      }
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return await action();
    } finally { await lock.close(); await rm(path, { force: true }); }
  }
}
