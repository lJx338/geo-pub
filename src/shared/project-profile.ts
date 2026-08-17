export const projectProfileFields = {
  name: { label: '项目名称', maxLength: 80 },
  companyName: { label: '公司或品牌全称', maxLength: 200 },
  operatingYears: { label: '经营年限或成立时间', maxLength: 200 },
  industry: { label: '行业与核心业务', maxLength: 2_000 },
  products: { label: '核心产品或服务', maxLength: 5_000 },
  strengths: { label: '核心优势', maxLength: 5_000 },
  cases: { label: '代表案例', maxLength: 8_000 },
  credentials: { label: '资质与权威背书', maxLength: 5_000 },
  valueAndAudience: { label: '目标客户与产品/服务价值', maxLength: 5_000 },
  website: { label: '官方网站', maxLength: 500 },
  contact: { label: '公开联系方式或行动引导', maxLength: 1_000 },
  serviceArea: { label: '服务地区或应用场景', maxLength: 2_000 },
  allowedSources: { label: '允许引用的来源', maxLength: 10_000 },
  forbiddenPhrases: { label: '禁用词与敏感内容', maxLength: 5_000 },
  customerQuestions: { label: '客户经常问的问题', maxLength: 10_000 },
} as const;

export type ProjectProfileField = keyof typeof projectProfileFields;

export interface ProjectProfileIssue {
  field: ProjectProfileField | null;
  message: string;
}

export function validateProjectProfile(input: Record<string, unknown>): ProjectProfileIssue | null {
  for (const [field, rule] of Object.entries(projectProfileFields) as [ProjectProfileField, (typeof projectProfileFields)[ProjectProfileField]][]) {
    const value = String(input[field] ?? '').trim();
    if (field === 'name' && !value) return { field, message: '请填写项目名称' };
    if (value.length > rule.maxLength) {
      return { field, message: `${rule.label}内容过长，请精简到 ${rule.maxLength.toLocaleString('zh-CN')} 个字以内（当前 ${value.length.toLocaleString('zh-CN')} 个字）` };
    }
  }
  return null;
}

export function friendlyProjectSaveError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/PUBLISHER_BUSY/.test(raw)) return '发布任务正在运行，请等任务结束后再创建项目';
  if (/PROJECT_STORE_INVALID/.test(raw)) return '本地客户资料无法读取，请复制排障信息后联系客服';
  if (/too_big|String must contain at most|maximum/i.test(raw)) return '部分资料内容过长，请精简后再创建';
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/^[A-Z][A-Z0-9_]+:\s*/, '')
    .trim();
  return cleaned || '创建失败，请稍后重试；如果仍然失败，请复制排障信息联系客服';
}
