export function contentMatchesExpected(actualValue: unknown, expectedValue: unknown): boolean {
  const normalize = (value: unknown): string => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const actual = normalize(actualValue);
  const expected = normalize(expectedValue);
  if (!actual || !expected) return false;
  if (actual.includes(expected)) return true;

  // Rich editors often remove the line break between a paragraph and a list
  // item when exposing innerText (for example "。下一步" instead of
  // "。 下一步"). That is presentation normalization, not a lost paragraph.
  const compact = (value: string) => value.replace(/[\s\-•·]/g, '');
  if (compact(actual).includes(compact(expected))) return true;

  const sampleLength = Math.min(18, Math.max(8, Math.floor(expected.length / 8)));
  const lastStart = Math.max(0, expected.length - sampleLength);
  const starts = [
    0,
    Math.floor((expected.length - sampleLength) * 0.25),
    Math.floor((expected.length - sampleLength) * 0.5),
    Math.floor((expected.length - sampleLength) * 0.75),
    lastStart,
  ];
  const samples = [...new Set(starts.map((start) => expected.slice(Math.max(0, start), Math.max(0, start) + sampleLength)).filter(Boolean))];
  const hits = samples.filter((sample) => actual.includes(sample)).length;
  const lengthRatio = actual.length / expected.length;
  return hits >= Math.min(3, samples.length) && lengthRatio >= 0.7;
}
