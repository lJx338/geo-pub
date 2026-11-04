const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const genericWords = new Set(['安全', '管理', '技术', '行业', '企业', '内容', '问题', '方法', '知识', '经验', '服务', '产品', '相关', '其他', '测试', '的话题', '话题']);
const key = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
function words(value: string): string[] {
  const parts = [...segmenter.segment(value)].filter(part => part.isWordLike).map(part => part.segment);
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i]!;
    if (/^\p{Script=Han}$/u.test(part)) {
      while (i + 1 < parts.length && /^\p{Script=Han}$/u.test(parts[i + 1]!)) part += parts[++i];
      if (part.length === 1 && result.length && /^\p{Script=Han}+$/u.test(result[result.length - 1]!)) {
        result[result.length - 1] += part; continue;
      }
    }
    result.push(part);
  }
  return result;
}
const meaningful = (value: string) => key(value).length >= 2 && !genericWords.has(key(value));

export function zhihuTopicSearchQueries(topic: string): string[] {
  const parts = words(topic);
  const queries = [topic];
  // Keep words/acronyms intact. Try progressively shorter phrases, then the
  // remaining specific words. Never turn CNC into CN or split a Chinese word.
  for (let length = parts.length - 1; length > 0; length--) queries.push(parts.slice(0, length).join(''));
  queries.push(...parts.filter(meaningful));
  return [...new Map([topic, ...queries.slice(1).filter(meaningful)].map(value => [key(value), value])).values()].slice(0, 4);
}

export interface ZhihuTopicChoice { selected: string; reason: string }

export function chooseZhihuTopic(requested: string, candidates: readonly string[], articleText: string): ZhihuTopicChoice | null {
  const names = [...new Map(candidates.map(value => [key(value), value])).values()];
  const exact = names.find(value => key(value) === key(requested));
  if (exact) return { selected: exact, reason: '同名匹配' };
  const anchors = words(requested).filter(meaningful).map(key);
  const context = key(articleText.replace(/<[^>]*>/g, ' '));
  const ranked = names.flatMap(name => {
    const normalized = key(name);
    // A common keyword alone does not justify a different subject. Every extra
    // qualifier must be supported by the article, or be an equivalent acronym.
    const shared = anchors.filter(anchor => normalized.includes(anchor));
    if (!shared.length) return [];
    let remainder = normalized;
    for (const anchor of shared.sort((a, b) => b.length - a.length)) remainder = remainder.replaceAll(anchor, ' ');
    const qualifiers = words(remainder).map(key);
    let evidence = 0;
    for (const qualifier of qualifiers) {
      if (qualifier.length < 2 || ['相关', '其他', '话题', '的话题'].includes(qualifier)) return [];
      const negated = ['不涉及', '不讨论', '不包含', '无关', '并非', '不是'].some(prefix => context.includes(prefix + qualifier) || context.includes(prefix + normalized));
      if (negated) return [];
      if (context.includes(qualifier)) evidence += 4;
      else if (qualifier === '数控' && shared.includes('cnc')) evidence += 1;
      else return [];
    }
    // Prefer more of the original subject and explicit contextual evidence.
    const score = shared.reduce((sum, anchor) => sum + anchor.length * 3, 0) + evidence;
    return [{ name, score, reason: qualifiers.length ? `保留关键词“${shared.join('、')}”，候选限定词与正文相符` : `使用原话题的较宽泛分类“${name}”` }];
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  // Equal-strength alternatives require a better keyword, not arbitrary order.
  if (!best || (ranked[1] && ranked[1].score === best.score)) return null;
  return { selected: best.name, reason: best.reason };
}
