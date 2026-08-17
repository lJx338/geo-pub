import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { dataDirectory } from './runtime-paths.js';
import { projectProfileFields } from '../shared/project-profile.js';

const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(projectProfileFields.name.maxLength),
  companyName: z.string().trim().max(projectProfileFields.companyName.maxLength).default(''),
  operatingYears: z.string().trim().max(projectProfileFields.operatingYears.maxLength).default(''),
  industry: z.string().trim().max(projectProfileFields.industry.maxLength).default(''),
  products: z.string().trim().max(projectProfileFields.products.maxLength).default(''),
  strengths: z.string().trim().max(projectProfileFields.strengths.maxLength).default(''),
  cases: z.string().trim().max(projectProfileFields.cases.maxLength).default(''),
  credentials: z.string().trim().max(projectProfileFields.credentials.maxLength).default(''),
  valueAndAudience: z.string().trim().max(projectProfileFields.valueAndAudience.maxLength).default(''),
  website: z.string().trim().max(projectProfileFields.website.maxLength).default(''),
  contact: z.string().trim().max(projectProfileFields.contact.maxLength).default(''),
  serviceArea: z.string().trim().max(projectProfileFields.serviceArea.maxLength).default(''),
  allowedSources: z.string().trim().max(projectProfileFields.allowedSources.maxLength).default(''),
  forbiddenPhrases: z.string().trim().max(projectProfileFields.forbiddenPhrases.maxLength).default(''),
  customerQuestions: z.string().trim().max(projectProfileFields.customerQuestions.maxLength).default(''),
  accountNotes: z.record(z.string(), z.string().trim().max(120)).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable().default(null),
});

const storeSchema = z.object({
  schemaVersion: z.literal(1),
  currentProjectId: z.string().uuid().nullable(),
  projects: z.array(projectSchema),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectInput = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'archivedAt'>> & Pick<Project, 'name'>;

function storePath(): string { return join(dataDirectory(), 'projects.json'); }

export class ProjectStore {
  private state: z.infer<typeof storeSchema> = { schemaVersion: 1, currentProjectId: null, projects: [] };
  constructor(private readonly path = storePath()) {}

  async load(): Promise<void> {
    try {
      this.state = storeSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        this.state = { schemaVersion: 1, currentProjectId: null, projects: [] };
      } else {
        throw new Error(`PROJECT_STORE_INVALID: 客户项目资料无法读取，请恢复备份后重试：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.state.currentProjectId && !this.find(this.state.currentProjectId)) this.state.currentProjectId = null;
  }

  list(): Project[] { return this.state.projects.filter((project) => !project.archivedAt); }
  current(): Project | null { return this.state.currentProjectId ? this.find(this.state.currentProjectId) ?? null : null; }
  get(id: string): Project | null { return this.find(id) ?? null; }

  async create(input: ProjectInput): Promise<Project> {
    const now = new Date().toISOString();
    const project = projectSchema.parse({ ...input, id: randomUUID(), createdAt: now, updatedAt: now, archivedAt: null });
    this.state.projects.push(project);
    this.state.currentProjectId = project.id;
    await this.save();
    return project;
  }

  async update(id: string, input: Partial<ProjectInput>): Promise<Project> {
    const index = this.state.projects.findIndex((project) => project.id === id && !project.archivedAt);
    if (index < 0) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    const existing = this.state.projects[index]!;
    const project = projectSchema.parse({ ...existing, ...input, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
    this.state.projects[index] = project;
    await this.save();
    return project;
  }

  async select(id: string): Promise<Project> {
    const project = this.find(id);
    if (!project) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    if (project.archivedAt) throw new Error('PROJECT_ARCHIVED: 该客户项目已归档');
    this.state.currentProjectId = id;
    await this.save();
    return project;
  }

  async archive(id: string): Promise<void> {
    const project = this.find(id);
    if (!project) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    project.archivedAt = new Date().toISOString();
    project.updatedAt = project.archivedAt;
    if (this.state.currentProjectId === id) this.state.currentProjectId = this.list()[0]?.id ?? null;
    await this.save();
  }

  export(id: string): Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'archivedAt'> {
    const project = this.find(id);
    if (!project || project.archivedAt) throw new Error('PROJECT_NOT_FOUND: 找不到客户项目');
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, archivedAt: _archivedAt, ...profile } = project;
    return profile;
  }

  async import(profile: ProjectInput): Promise<Project> {
    return await this.create(profile);
  }

  private find(id: string): Project | undefined { return this.state.projects.find((project) => project.id === id); }

  private async save(): Promise<void> {
    const path = this.path;
    const temporary = `${path}.${process.pid}.new`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(this.state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }
}
