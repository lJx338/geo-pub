import { z } from 'zod';

export const baijiaSmartCreationOptionSchema = z.enum(['autoPodcast', 'convertToDynamic']);
export const baijiaDeclarationOptionSchema = z.enum(['aiGenerated', 'source']);

const distinct = <T>(values: T[]) => [...new Set(values)];
const baijiaFields = {
  smartCreation: z.array(baijiaSmartCreationOptionSchema).max(2).transform(distinct),
  declarations: z.array(baijiaDeclarationOptionSchema).max(2).transform(distinct),
  sourceDate: z.string().trim().max(10),
  sourceLocation: z.string().trim().max(80),
};

export const defaultBaijiaSettings = {
  smartCreation: [] as Array<z.infer<typeof baijiaSmartCreationOptionSchema>>,
  declarations: ['aiGenerated'] as Array<z.infer<typeof baijiaDeclarationOptionSchema>>,
  sourceDate: '',
  sourceLocation: '',
};

export const baijiaSettingsSchema = z.object({
  smartCreation: baijiaFields.smartCreation.default([]),
  declarations: baijiaFields.declarations.default(['aiGenerated']),
  sourceDate: baijiaFields.sourceDate.default(''),
  sourceLocation: baijiaFields.sourceLocation.default(''),
}).superRefine((settings, context) => {
  if (!settings.declarations.includes('source')) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.sourceDate)) {
    context.addIssue({ code: 'custom', path: ['sourceDate'], message: '选择来源说明后，请填写来源日期' });
  }
  if (!settings.sourceLocation) {
    context.addIssue({ code: 'custom', path: ['sourceLocation'], message: '选择来源说明后，请填写来源地点' });
  }
});
export type BaijiaSettings = z.infer<typeof baijiaSettingsSchema>;

export const liejuSettingsSchema = z.object({
  cityId: z.string().regex(/^\d*$/).default(''),
  categoryId: z.string().regex(/^\d*$/).default(''),
  districtId: z.string().regex(/^\d*$/).default(''),
  subcategoryId: z.string().trim().max(100).default(''),
  company: z.string().trim().max(100).default(''),
  phone: z.string().trim().max(20).default(''),
  contact: z.string().trim().max(25).default(''),
  price: z.string().regex(/^[1-9]\d*$/, '单价必须是正整数').max(12).default('1'),
  extraFields: z.record(z.string().regex(/^atc_[a-zA-Z0-9_]+$/), z.string().trim().max(500)).default({}),
});
export type LiejuSettings = z.infer<typeof liejuSettingsSchema>;
export const defaultLiejuSettings = liejuSettingsSchema.parse({});

export type LiejuFormField = {
  id: string; label: string; required: boolean; kind: 'select' | 'text';
  options: Array<{ value: string; label: string }>; maxLength?: number;
};
export type LiejuFormOptions = { fields: LiejuFormField[] };

export function resolveLiejuSettings(defaults: PublishingDefaults | null | undefined, override?: PlatformOptions['lieju']): LiejuSettings {
  return liejuSettingsSchema.parse({ ...defaultLiejuSettings, ...defaults?.lieju, ...override });
}

export const publishingDefaultsSchema = z.object({
  baijia: baijiaSettingsSchema,
  lieju: liejuSettingsSchema.optional(),
}).default({ baijia: defaultBaijiaSettings });
export type PublishingDefaults = z.infer<typeof publishingDefaultsSchema>;

export const platformOptionsSchema = z.object({
  lieju: liejuSettingsSchema.partial().optional(),
  baijia: z.object(baijiaFields).partial().optional(),
  wechat: z.object({
    title: z.string().trim().min(2).refine((value) => [...value].length <= 32, '公众号标题最多 32 个字').optional(),
    author: z.string().trim().refine((value) => [...value].length <= 16, '作者最多 16 个字').optional(),
    expectedAppId: z.string().regex(/^wx[a-zA-Z0-9]{16}$/).optional(),
  }).strict().optional(),
}).default({});
export type PlatformOptions = z.infer<typeof platformOptionsSchema>;

export function resolveBaijiaSettings(
  defaults: PublishingDefaults | null | undefined,
  override: PlatformOptions['baijia'] | null | undefined,
): BaijiaSettings {
  return baijiaSettingsSchema.parse({ ...defaultBaijiaSettings, ...(defaults?.baijia || {}), ...(override || {}) });
}
