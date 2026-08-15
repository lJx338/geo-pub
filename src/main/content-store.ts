import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { dataDirectory } from './runtime-paths.js';

const contentItemSchema = z.object({
  id: z.string().min(1), projectId: z.string().uuid(), kind: z.enum(['material', 'topic', 'article', 'distribution']),
  title: z.string().trim().max(240).default(''), status: z.string().trim().max(80).default('draft'), platform: z.string().trim().max(40).default(''), category: z.string().trim().max(80).default(''),
  topicFamilyId: z.string().trim().max(80).default(''), parentTopicId: z.string().trim().max(80).default(''), variantNumber: z.number().int().positive().default(1), usageCount: z.number().int().nonnegative().default(0),
  lastUsedAt: z.string().datetime().nullable().default(null), reusePolicy: z.enum(['standard', 'evergreen']).default('standard'), cooldownDays: z.number().int().nonnegative().default(0), reservedBy: z.string().trim().max(120).default(''), reservedUntil: z.string().datetime().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});

export type ContentKind = z.infer<typeof contentItemSchema>['kind'];
export type ContentItem = z.infer<typeof contentItemSchema>;
export type ContentInput = Partial<Pick<ContentItem, 'id' | 'title' | 'status' | 'platform' | 'category' | 'topicFamilyId' | 'parentTopicId' | 'variantNumber' | 'usageCount' | 'lastUsedAt' | 'reusePolicy' | 'cooldownDays' | 'reservedBy' | 'reservedUntil' | 'payload'>> & { kind: ContentKind };
export type ContentFilter = { status?: string; category?: string; platform?: string; reusePolicy?: 'standard' | 'evergreen'; query?: string; autoSelectable?: boolean };

const columns = 'id, project_id, kind, title, status, platform, category, topic_family_id, parent_topic_id, variant_number, usage_count, last_used_at, reuse_policy, cooldown_days, reserved_by, reserved_until, payload, created_at, updated_at';

export class ContentStore {
  private readonly database: DatabaseSync;
  constructor(private readonly root = join(dataDirectory(), 'content')) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(root, 'content.sqlite3'));
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS content_items (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', platform TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
      topic_family_id TEXT NOT NULL DEFAULT '', parent_topic_id TEXT NOT NULL DEFAULT '', variant_number INTEGER NOT NULL DEFAULT 1, usage_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
      reuse_policy TEXT NOT NULL DEFAULT 'standard', cooldown_days INTEGER NOT NULL DEFAULT 0, reserved_by TEXT NOT NULL DEFAULT '', reserved_until TEXT, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_content_project_kind ON content_items(project_id, kind); CREATE INDEX IF NOT EXISTS idx_content_topic_family ON content_items(project_id, topic_family_id);`);
  }

  async list(projectId: string, kind?: ContentKind, filter: ContentFilter = {}): Promise<ContentItem[]> {
    const conditions = ['project_id = ?']; const values: SQLInputValue[] = [projectId];
    if (kind) { conditions.push('kind = ?'); values.push(kind); }
    if (filter.status) { conditions.push('status = ?'); values.push(filter.status); }
    if (filter.category) { conditions.push('category = ?'); values.push(filter.category); }
    if (filter.platform) { conditions.push('platform = ?'); values.push(filter.platform); }
    if (filter.reusePolicy) { conditions.push('reuse_policy = ?'); values.push(filter.reusePolicy); }
    const rows = this.database.prepare(`SELECT ${columns} FROM content_items WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`).all(...values) as Record<string, unknown>[]; const now = Date.now();
    return rows.map((row) => this.fromRow(row)).filter((item) => (!filter.query || `${item.title} ${JSON.stringify(item.payload)}`.toLowerCase().includes(filter.query.toLowerCase())) && (!filter.autoSelectable || this.isTopicAutoSelectable(item, now)));
  }

  async save(projectId: string, input: ContentInput): Promise<ContentItem> {
    const owner = input.id ? this.database.prepare('SELECT project_id FROM content_items WHERE id = ?').get(input.id) as { project_id: string } | undefined : undefined;
    if (owner && owner.project_id !== projectId) throw new Error('PROJECT_CONTENT_MISMATCH: 内容属于其他客户项目');
    const existing = input.id ? this.database.prepare(`SELECT ${columns} FROM content_items WHERE project_id = ? AND id = ?`).get(projectId, input.id) as Record<string, unknown> | undefined : undefined;
    const old = existing ? this.fromRow(existing) : undefined; const now = new Date().toISOString();
    if (old && old.kind !== input.kind) throw new Error('CONTENT_KIND_MISMATCH: 不能修改已有内容的类型');
    const item = contentItemSchema.parse({ id: old?.id ?? input.id ?? crypto.randomUUID(), projectId, kind: input.kind, title: input.title ?? old?.title ?? '', status: input.status ?? old?.status ?? 'draft', platform: input.platform ?? old?.platform ?? '', category: input.category ?? old?.category ?? '',
      topicFamilyId: input.topicFamilyId ?? old?.topicFamilyId ?? (input.kind === 'topic' ? (input.id || crypto.randomUUID()) : ''), parentTopicId: input.parentTopicId ?? old?.parentTopicId ?? '', variantNumber: input.variantNumber ?? old?.variantNumber ?? 1,
      usageCount: input.usageCount ?? old?.usageCount ?? 0, lastUsedAt: 'lastUsedAt' in input ? input.lastUsedAt : (old?.lastUsedAt ?? null), reusePolicy: input.reusePolicy ?? old?.reusePolicy ?? 'standard', cooldownDays: input.cooldownDays ?? old?.cooldownDays ?? 0,
      reservedBy: input.reservedBy ?? old?.reservedBy ?? '', reservedUntil: 'reservedUntil' in input ? input.reservedUntil : (old?.reservedUntil ?? null), payload: input.payload ?? old?.payload ?? {}, createdAt: old?.createdAt ?? now, updatedAt: now });
    this.upsert(item);
    return item;
  }

  async reserveTopic(projectId: string, topicId: string, taskId: string, ttlMs = 10 * 60 * 1000): Promise<ContentItem> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findSync(projectId, topicId, 'topic');
      if (current.reservedBy && current.reservedBy !== taskId && current.reservedUntil && Date.parse(current.reservedUntil) > Date.now()) throw new Error('TOPIC_RESERVED: 选题正在被另一项任务使用');
      if (!this.isTopicAutoSelectable(current, Date.now()) && current.reservedBy !== taskId) throw new Error('TOPIC_NOT_AVAILABLE: 该选题当前不可自动使用，请创建主题变体或手动恢复');
      const item = contentItemSchema.parse({ ...current, status: 'reserved', reservedBy: taskId, reservedUntil: new Date(Date.now() + ttlMs).toISOString(), updatedAt: new Date().toISOString() }); this.upsert(item); this.database.exec('COMMIT'); return item;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  async releaseTopic(projectId: string, topicId: string, taskId?: string): Promise<ContentItem> {
    const current = await this.find(projectId, topicId, 'topic'); if (taskId && current.reservedBy && current.reservedBy !== taskId) throw new Error('TOPIC_RESERVATION_OWNER_MISMATCH: 选题占用者不匹配');
    return this.save(projectId, { id: topicId, kind: 'topic', status: current.usageCount > 0 ? 'used' : 'approved', reservedBy: '', reservedUntil: null });
  }

  async markTopicUsed(projectId: string, topicId: string, articleId: string, taskId?: string): Promise<ContentItem> {
    const current = await this.find(projectId, topicId, 'topic'); if (taskId && current.reservedBy && current.reservedBy !== taskId) throw new Error('TOPIC_RESERVATION_OWNER_MISMATCH: 选题占用者不匹配');
    const usedAt = new Date().toISOString(); const history = Array.isArray(current.payload.usageHistory) ? current.payload.usageHistory : [];
    return this.save(projectId, { id: topicId, kind: 'topic', status: 'used', usageCount: current.usageCount + 1, lastUsedAt: usedAt, reservedBy: '', reservedUntil: null, payload: { ...current.payload, lastArticleId: articleId, usageHistory: [...history, { articleId, usedAt }] } });
  }

  async createTopicVariant(projectId: string, topicId: string, input: ContentInput): Promise<ContentItem> {
    const parent = await this.find(projectId, topicId, 'topic'); const familyId = parent.topicFamilyId || parent.id; const siblings = (await this.list(projectId, 'topic')).filter((item) => (item.topicFamilyId || item.id) === familyId);
    if (!parent.topicFamilyId) await this.save(projectId, { id: parent.id, kind: 'topic', topicFamilyId: familyId });
    return this.save(projectId, { ...input, kind: 'topic', parentTopicId: parent.id, topicFamilyId: familyId, variantNumber: Math.max(0, ...siblings.map((item) => item.variantNumber)) + 1, status: input.status ?? 'approved', reusePolicy: input.reusePolicy ?? parent.reusePolicy });
  }

  async importMaterial(projectId: string, sourcePath: string, input: Omit<ContentInput, 'kind'> = {}): Promise<ContentItem> {
    const source = await readFile(sourcePath); const hash = createHash('sha256').update(source).digest('hex'); const existing = (await this.list(projectId, 'material')).find((item) => item.payload.hash === hash); if (existing) return existing;
    const sourceName = sourcePath.split(/[\\/]/).pop() || 'material'; const destination = join(this.root, projectId, 'materials', `${hash.slice(0, 16)}-${sourceName}`); await mkdir(join(this.root, projectId, 'materials'), { recursive: true }); await copyFile(sourcePath, destination);
    const extracted = this.extractMaterial(sourceName, source);
    return this.save(projectId, { ...input, kind: 'material', title: input.title || sourceName, status: input.status || (extracted.category === 'pending_review' ? 'pending_review' : 'active'), category: input.category || extracted.category, payload: { ...(input.payload || {}), sourceType: 'file', sourceName, sourcePath: destination, hash, summary: extracted.summary, facts: extracted.facts, confidence: extracted.category === 'pending_review' ? 'needs_review' : 'auto_classified' } });
  }

  private async find(projectId: string, id: string, kind?: ContentKind): Promise<ContentItem> {
    return this.findSync(projectId, id, kind);
  }

  private findSync(projectId: string, id: string, kind?: ContentKind): ContentItem {
    const args: SQLInputValue[] = [projectId, id]; const kindClause = kind ? ' AND kind = ?' : ''; if (kind) args.push(kind);
    const row = this.database.prepare(`SELECT ${columns} FROM content_items WHERE project_id = ? AND id = ?${kindClause}`).get(...args) as Record<string, unknown> | undefined; if (!row) throw new Error('CONTENT_NOT_FOUND: 找不到内容'); return this.fromRow(row);
  }

  private isTopicAutoSelectable(item: ContentItem, now: number): boolean {
    if (item.kind !== 'topic' || item.status !== 'approved') return false; if (item.reservedUntil && Date.parse(item.reservedUntil) > now) return false; if (item.lastUsedAt && item.cooldownDays > 0 && Date.parse(item.lastUsedAt) + item.cooldownDays * 86400000 > now) return false; return true;
  }

  private extractMaterial(sourceName: string, source: Buffer): { category: string; summary: string; facts: string[] } {
    const extension = sourceName.toLowerCase().split('.').pop() || '';
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov'].includes(extension)) return { category: 'media', summary: '图片或视频素材，等待 WorkBuddy 根据使用场景补充说明。', facts: [] };
    const text = ['txt', 'md', 'json', 'csv', 'html'].includes(extension) ? source.toString('utf8').replace(/\s+/g, ' ').trim() : '';
    const corpus = `${sourceName} ${text}`.toLowerCase();
    const rules: Array<[string, RegExp]> = [['case', /案例|客户|项目结果|实施效果/], ['credential', /资质|证书|专利|荣誉|认证/], ['faq', /问答|常见问题|客户问题|faq/], ['product', /产品|服务|参数|规格|解决方案/], ['company', /公司|品牌|企业简介|关于我们/], ['industry', /行业|标准|技术资料|白皮书/]];
    const category = rules.find(([, pattern]) => pattern.test(corpus))?.[0] || 'pending_review';
    const summary = text ? text.slice(0, 180) : '文件已安全保存，需由 WorkBuddy 提取正文并确认分类。';
    const facts = text ? text.split(/[。！？;；]/).map((value) => value.trim()).filter((value) => value.length >= 4).slice(0, 12) : [];
    return { category, summary, facts };
  }

  private fromRow(row: Record<string, unknown>): ContentItem {
    return contentItemSchema.parse({ id: row.id, projectId: row.project_id, kind: row.kind, title: row.title, status: row.status, platform: row.platform, category: row.category, topicFamilyId: row.topic_family_id, parentTopicId: row.parent_topic_id, variantNumber: row.variant_number, usageCount: row.usage_count, lastUsedAt: row.last_used_at || null, reusePolicy: row.reuse_policy, cooldownDays: row.cooldown_days, reservedBy: row.reserved_by, reservedUntil: row.reserved_until || null, payload: JSON.parse(String(row.payload || '{}')), createdAt: row.created_at, updatedAt: row.updated_at });
  }

  private toValues(item: ContentItem): SQLInputValue[] { return [item.id, item.projectId, item.kind, item.title, item.status, item.platform, item.category, item.topicFamilyId, item.parentTopicId, item.variantNumber, item.usageCount, item.lastUsedAt, item.reusePolicy, item.cooldownDays, item.reservedBy, item.reservedUntil, JSON.stringify(item.payload), item.createdAt, item.updatedAt]; }

  private upsert(item: ContentItem): void {
    const placeholders = columns.split(', ').map(() => '?').join(', ');
    this.database.prepare(`INSERT INTO content_items (${columns}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, kind=excluded.kind, title=excluded.title, status=excluded.status, platform=excluded.platform, category=excluded.category, topic_family_id=excluded.topic_family_id, parent_topic_id=excluded.parent_topic_id, variant_number=excluded.variant_number, usage_count=excluded.usage_count, last_used_at=excluded.last_used_at, reuse_policy=excluded.reuse_policy, cooldown_days=excluded.cooldown_days, reserved_by=excluded.reserved_by, reserved_until=excluded.reserved_until, payload=excluded.payload, updated_at=excluded.updated_at`).run(...this.toValues(item));
  }

}
