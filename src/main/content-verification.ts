export function contentMatchesExpected(actualValue: unknown, expectedValue: unknown): boolean {
  const normalize = (value: unknown): string => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const actual = normalize(actualValue);
  const expected = normalize(expectedValue);
  if (!actual || !expected) return false;
  // This function is called with the editor body, never the whole page. A
  // substring or sampling match accepts duplicated, truncated and unrelated
  // drafts, so only editor-safe whitespace normalization is permitted.
  return actual === expected;
}

export function contentContainsExpectedBlocks(actualValue: unknown, expectedValues: unknown[]): boolean {
  const normalize = (value: unknown): string => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const actual = normalize(actualValue);
  const expected = expectedValues.map(normalize).filter(Boolean);
  if (!actual || expected.length === 0) return false;

  let offset = 0;
  let expectedLength = 0;
  for (const block of expected) {
    const index = actual.indexOf(block, offset);
    if (index < 0) return false;
    offset = index + block.length;
    expectedLength += block.length;
  }

  // Rich-text editors may add separators or list markers between intact
  // blocks. Keep the allowance bounded so duplicated or unrelated drafts are
  // still rejected.
  const maximumEditorOverhead = Math.max(32, Math.ceil(expectedLength * 0.08));
  return actual.length >= expectedLength && actual.length - expectedLength <= maximumEditorOverhead;
}

export type DraftBlockCountState = 'match' | 'missing' | 'duplicate';

export function classifyDraftBlockCount(expected: number, actual: number): DraftBlockCountState {
  if (actual === expected) return 'match';
  return actual < expected ? 'missing' : 'duplicate';
}
