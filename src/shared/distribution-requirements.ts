import { normalizeArticleTags } from './article-document.js';

// Lingxi's publishing policy, not a claim about each platform's own rules.
export function distributionInputIssues(platforms: readonly string[], tags: readonly string[], coverPath: string) {
  const issues: Array<{ code: string; field: 'coverPath' | 'tags'; message: string }> = [];
  if (platforms.some(platform => platform !== 'lieju') && !coverPath.trim()) {
    issues.push({ code: 'COVER_REQUIRED', field: 'coverPath', message: '除列举网外，所有平台必须选择封面图片' });
  }
  if (platforms.includes('zhihu') && !normalizeArticleTags(tags, 9).length) {
    issues.push({ code: 'ZHIHU_TOPICS_REQUIRED', field: 'tags', message: '知乎必须提供至少一个有效话题，并确认在文章话题栏选中' });
  }
  return issues;
}

export function assertDistributionInput(platforms: readonly string[], tags: readonly string[], coverPath: string) {
  const issue = distributionInputIssues(platforms, tags, coverPath)[0];
  if (issue) throw new Error(`${issue.code}: ${issue.message}`);
}

export function assertRequiredFillFields(platform: string, result: unknown) {
  const fields = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const stop = (code: string, message: string): never => {
    throw Object.assign(new Error(`${code}: ${message}`), { details: { ...fields, platform } });
  };
  if (['zhihu', 'penguin', 'sohu'].includes(platform)
    && (fields.coverUploaded !== true || fields.coverStatus !== 'applied')) {
    stop(`${platform.toUpperCase()}_COVER_NOT_APPLIED`, '未确认封面已上传并应用，已停止，不能继续发布');
  }
  if (platform === 'zhihu' && (!Array.isArray(fields.topicsApplied)
    || !normalizeArticleTags(fields.topicsApplied.filter((value): value is string => typeof value === 'string'), 9).length)) {
    stop('ZHIHU_TOPICS_NOT_SELECTED', '未确认选中任何文章话题，已停止，不能继续发布；正文中的 #话题不算已选话题');
  }
}
