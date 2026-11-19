import { z } from 'zod';

const length = z.int().nonnegative();
const blocks = z.object({ headings: length, lists: length, quotes: length, dividers: length, images: length });

// Only these fields can enter an exported bundle. In particular, the comparison
// describes a range in normalized text without retaining the text in that range.
export const toutiaoContentDiagnosticSchema = z.object({
  stage: z.enum(['initial_fill', 'after_save_check', 'before_publish']),
  checks: z.array(z.object({
    method: z.enum(['read', 'insert', 'paste']),
    writePath: z.enum(['editor_paste', 'insert_html', 'replace_dom', 'editor_missing']).nullable(),
    titleFound: z.boolean(),
    editorFound: z.boolean(),
    titleFilled: z.boolean(),
    bodyFilled: z.boolean(),
    difference: z.enum(['match', 'editor_missing', 'empty_source', 'missing_text', 'extra_text', 'changed_text']),
    expectedLength: length,
    actualLength: length,
    mismatchAt: z.int().positive().nullable(),
    expectedSpanLength: length,
    actualSpanLength: length,
    expectedBlocks: blocks,
    actualBlocks: blocks,
  })).min(1).max(3),
});

export type ToutiaoContentDiagnostic = z.infer<typeof toutiaoContentDiagnosticSchema>;
export type ToutiaoContentCheck = ToutiaoContentDiagnostic['checks'][number];
