import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { dataDirectory } from './runtime-paths.js';

const contentItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().uuid(),
  kind: z.enum(['material', 'topic', 'article', 'distribution']),
  title: z.string().trim().max(240).default(''),
  status: z.string().trim().max(80).default('draft'),
  platform: z.string().trim().max(40).default(''),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ContentKind = z.infer<typeof contentItemSchema>['kind'];
export type ContentItem = z.infer<typeof contentItemSchema>;
export type ContentInput = Partial<Pick<ContentItem, 'id' | 'title' | 'status' | 'platform' | 'payload'>> & { kind: ContentKind };

export class ContentStore {
  private readonly items = new Map<string, ContentItem[]>();
  constructor(private readonly root = join(dataDirectory(), 'content')) {}

  async list(projectId: string, kind?: ContentKind): Promise<ContentItem[]> {
    const items = await this.load(projectId);
    return items.filter((item) => !kind || item.kind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(projectId: string, input: ContentInput): Promise<ContentItem> {
    const items = await this.load(projectId);
    const now = new Date().toISOString();
    const existing = input.id ? items.find((item) => item.id === input.id) : undefined;
    const item = contentItemSchema.parse({
      id: existing?.id ?? input.id ?? crypto.randomUUID(),
      projectId,
      kind: input.kind,
      title: input.title ?? existing?.title ?? '',
      status: input.status ?? existing?.status ?? 'draft',
      platform: input.platform ?? existing?.platform ?? '',
      payload: input.payload ?? existing?.payload ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    await this.write(projectId, items);
    return item;
  }

  private async load(projectId: string): Promise<ContentItem[]> {
    const cached = this.items.get(projectId);
    if (cached) return cached;
    try {
      const parsed = z.array(contentItemSchema).parse(JSON.parse(await readFile(this.contentPath(projectId), 'utf8')));
      this.items.set(projectId, parsed);
      return parsed;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        const empty: ContentItem[] = [];
        this.items.set(projectId, empty);
        return empty;
      }
      throw new Error(`CONTENT_STORE_INVALID: 内容库无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async write(projectId: string, items: ContentItem[]): Promise<void> {
    const path = this.contentPath(projectId);
    const temporary = `${path}.${process.pid}.new`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  private contentPath(projectId: string): string { return join(this.root, projectId, 'items.json'); }
}
