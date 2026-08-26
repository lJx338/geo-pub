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

export const publishingDefaultsSchema = z.object({
  baijia: baijiaSettingsSchema,
}).default({ baijia: defaultBaijiaSettings });
export type PublishingDefaults = z.infer<typeof publishingDefaultsSchema>;

export const platformOptionsSchema = z.object({
  baijia: z.object(baijiaFields).partial().optional(),
}).default({});
export type PlatformOptions = z.infer<typeof platformOptionsSchema>;

export function resolveBaijiaSettings(
  defaults: PublishingDefaults | null | undefined,
  override: PlatformOptions['baijia'] | null | undefined,
): BaijiaSettings {
  return baijiaSettingsSchema.parse({ ...defaultBaijiaSettings, ...(defaults?.baijia || {}), ...(override || {}) });
}
