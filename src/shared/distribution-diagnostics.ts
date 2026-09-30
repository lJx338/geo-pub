export type DistributionDiagnosisTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface DistributionDiagnosisRecord {
  platform?: string;
  title?: string;
  status?: string;
  updatedAt?: string;
  payload?: {
    mode?: string;
    error?: { code?: string; message?: string; details?: { platform?: string; url?: string; screenshotPath?: string | null; originalCode?: string; pageTitle?: string; visibleFieldCount?: number; editorCandidateCount?: number; loginVisible?: boolean } };
    evidence?: {
      stage?: string;
      message?: string;
      url?: string;
      screenshotPath?: string | null;
      settingsScreenshotPath?: string | null;
      coverScreenshotPath?: string | null;
    };
  };
}

export interface DistributionDiagnosis {
  tone: DistributionDiagnosisTone;
  title: string;
  summary: string;
  nextAction: string;
  retry: string;
  code: string;
  stage: string;
  evidence: string[];
}

const platformLabels: Record<string, string> = {
  baijia: '百家号',
  toutiao: '头条号',
  zhihu: '知乎',
  penguin: '企鹅号',
  sohu: '搜狐号',
  netease: '网易号',
};

const normalize = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();

function platformLabel(platform: string): string {
  return platformLabels[platform] || platform || '未知平台';
}

function failedDiagnosis(record: DistributionDiagnosisRecord, code: string, message: string): Omit<DistributionDiagnosis, 'evidence'> {
  if (code === 'BAIJIA_SETTING_NOT_APPLIED') {
    return {
      tone: 'danger', title: '百家号发布设置没有生效',
      summary: message || '百家号编辑器没有确认发布设置。',
      nextAction: '打开百家号编辑器并刷新；暂时关闭可选发布设置，保存后再做一次“仅填充”检查。',
      retry: '修正设置并确认填充页面后，可以只重试百家号。', code, stage: 'fill_settings',
    };
  }
  if (code === 'BAIJIA_COVER_NOT_APPLIED' || code === 'BAIJIA_COVER_STAGE') {
    return {
      tone: 'danger', title: '百家号封面没有确认应用',
      summary: message || '封面上传后，编辑器没有显示已应用状态。',
      nextAction: '人工刷新百家号编辑器，在封面弹窗中点击“确定”，等弹窗关闭并看到封面预览。',
      retry: '这是发布前失败，确认封面已应用后可以重试；不会重复提交文章。', code, stage: 'fill_cover',
    };
  }
  if (code === 'TOUTIAO_PREVIEW_TIMEOUT') {
    return {
      tone: 'warning', title: '头条预览后的结果没有确认',
      summary: message || '点击“预览并发布”后没有进入可确认的发布状态。',
      nextAction: '去头条号作品管理按标题查询，确认是草稿、审核中还是已发布。',
      retry: '先完成后台核对；在确认结果前不要再次点击发布。', code, stage: 'toutiao_preview',
    };
  }
  if (/^TOUTIAO_COVER_(?:NOT_APPLIED|STAGE|FILE_NOT_SET)/.test(code)) {
    return {
      tone: 'danger', title: '头条号封面没有上传完成',
      summary: message || '头条号封面弹窗没有确认已应用的图片。',
      nextAction: '打开头条草稿，进入“展示封面→单图”，重新选择本地图片，等预览出现并点击“确定”。',
      retry: '封面确认应用后，只重试头条号；当前文章仍保存在草稿箱，不会重复提交其他平台。', code, stage: 'fill_cover',
    };
  }
  if (code === 'SOHU_CONTENT_FILL_FAILED' || code === 'SOHU_CONTENT_SCRIPT_FAILED') {
    return {
      tone: 'danger', title: '搜狐号编辑器没有接收文章内容',
      summary: message || '搜狐页面没有确认标题和正文已经写入。',
      nextAction: '打开搜狐号发布页，确认已登录且标题输入框、正文编辑器已经出现；页面加载完成后再执行一次“仅填充”。',
      retry: '这是发布前填充失败，没有点击发布；确认编辑器可见后可以重试。', code, stage: 'content_fill',
    };
  }
  if (/额度|次数|上限|用尽|不能再发/.test(`${code} ${message}`)) {
    return {
      tone: 'warning', title: `${platformLabel(record.platform || '')}发布额度受限`,
      summary: message || '平台提示当天发布额度不可用。',
      nextAction: '打开平台后台确认额度和账号状态。',
      retry: '额度恢复前不要重试。', code, stage: 'platform_quota',
    };
  }
  if (/LOGIN_REQUIRED|VERIFICATION_REQUIRED|RISK_CONTROL_REQUIRED|验证码|登录|风控/.test(`${code} ${message}`)) {
    return {
      tone: 'warning', title: `${platformLabel(record.platform || '')}需要人工处理`,
      summary: message || '平台要求登录、验证或处理风险提示。',
      nextAction: '打开对应平台，完成登录、验证码或风控操作。',
      retry: '完成页面操作后再重试一次。', code, stage: 'manual_attention',
    };
  }
  if (/FORMAT_DEGRADED/.test(`${code} ${message}`)) {
    return {
      tone: 'danger', title: `${platformLabel(record.platform || '')}格式被平台降级`,
      summary: message || '平台编辑器没有保留文章结构。',
      nextAction: '不要继续发布，保留完整错误并检查平台适配器。',
      retry: '修复格式适配后再重试。', code, stage: 'format_verification',
    };
  }
  return {
    tone: 'danger', title: `${platformLabel(record.platform || '')}执行失败`,
    summary: message || '执行过程中出现未分类错误。',
    nextAction: '先检查登录状态、网络和平台页面是否正常。',
    retry: '确认原因后再重试；如果已经点击过发布，先去后台核对。', code, stage: 'failed',
  };
}

export function buildDistributionDiagnosis(record: DistributionDiagnosisRecord): DistributionDiagnosis {
  const status = normalize(record.status) || 'unknown';
  const payload = record.payload || {};
  const error = payload.error || {};
  const evidence = payload.evidence || {};
  const errorDetails = error.details || {};
  const code = normalize(error.code) || normalize(evidence.stage) || status;
  const message = normalize(error.message) || normalize(evidence.message);
  let result: Omit<DistributionDiagnosis, 'evidence'>;

  if (status === 'success') {
    result = { tone: 'success', title: `${platformLabel(record.platform || '')}已确认发布`, summary: message || '已完成发布并检测到成功状态。', nextAction: '可以在平台后台查看文章。', retry: '无需重试。', code: 'SUCCESS', stage: normalize(evidence.stage) || 'success' };
  } else if (status === 'filled') {
    result = { tone: 'success', title: `${platformLabel(record.platform || '')}已填充草稿`, summary: message || '内容已写入平台编辑器，但尚未点击发布。', nextAction: '打开平台检查标题、正文、封面和声明。', retry: '检查无误后再执行真实发布。', code: 'DRAFT_FILLED', stage: normalize(evidence.stage) || 'fill' };
  } else if (status === 'result_uncertain') {
    result = { tone: 'warning', title: `${platformLabel(record.platform || '')}结果待确认`, summary: message || '程序无法确认平台最终状态。', nextAction: '去平台作品管理按标题核对状态。', retry: '核对完成前禁止再次点击发布。', code: code || 'RESULT_UNCERTAIN', stage: normalize(evidence.stage) || 'result_check' };
  } else if (status === 'action_required') {
    result = failedDiagnosis(record, code, message);
    result = { ...result, tone: 'warning' };
  } else if (status === 'running') {
    result = { tone: 'warning', title: `${platformLabel(record.platform || '')}正在执行`, summary: '任务尚未写入最终结果。', nextAction: '等待任务结束后刷新分发记录。', retry: '任务结束前不要重复启动。', code: 'RUNNING', stage: normalize(evidence.stage) || 'running' };
  } else {
    result = failedDiagnosis(record, code, message);
  }

  return {
    ...result,
    evidence: [
      record.title ? `文章：${normalize(record.title)}` : '',
      record.updatedAt ? `时间：${normalize(record.updatedAt)}` : '',
      payload.mode ? `模式：${payload.mode === 'publish' ? '真实发布' : '仅填充'}` : '',
      code ? `代码：${code}` : '',
      result.stage ? `阶段：${result.stage}` : '',
      evidence.url ? `页面：${normalize(evidence.url)}` : '',
      evidence.screenshotPath ? `页面截图：${normalize(evidence.screenshotPath)}` : '',
      evidence.coverScreenshotPath ? `封面截图：${normalize(evidence.coverScreenshotPath)}` : '',
      evidence.settingsScreenshotPath ? `设置截图：${normalize(evidence.settingsScreenshotPath)}` : '',
      errorDetails.url ? `错误页面：${normalize(errorDetails.url)}` : '',
      errorDetails.screenshotPath ? `错误截图：${normalize(errorDetails.screenshotPath)}` : '',
      errorDetails.pageTitle ? `错误页面标题：${normalize(errorDetails.pageTitle)}` : '',
      errorDetails.visibleFieldCount !== undefined ? `可见输入控件：${errorDetails.visibleFieldCount}` : '',
      errorDetails.editorCandidateCount !== undefined ? `编辑器候选：${errorDetails.editorCandidateCount}` : '',
      errorDetails.loginVisible !== undefined ? `页面登录提示：${errorDetails.loginVisible ? '是' : '否'}` : '',
    ].filter(Boolean),
  };
}

export function distributionDiagnosisText(record: DistributionDiagnosisRecord): string {
  const diagnosis = buildDistributionDiagnosis(record);
  return [
    `GEO Publisher 分发诊断`,
    diagnosis.title,
    `结论：${diagnosis.summary}`,
    `下一步：${diagnosis.nextAction}`,
    `重试规则：${diagnosis.retry}`,
    ...diagnosis.evidence,
  ].join('\n');
}
