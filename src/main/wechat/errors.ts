export class WechatError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: { apiCode?: number; whitelistIp?: string } = {},
    /** The server may have accepted a write; callers must not automatically repeat it. */
    readonly uncertain = false,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WechatError';
  }
}

export function wechatApiError(code: number, remoteMessage: unknown): WechatError {
  const messages: Record<number, [string, string]> = {
    40013: ['WECHAT_APPID_INVALID', 'AppID 无效，请检查公众号连接设置'],
    40125: ['WECHAT_SECRET_INVALID', 'AppSecret 无效或已重置，请更新连接设置'],
    40001: ['WECHAT_TOKEN_INVALID', '接口凭据无效，请重新测试连接'],
    40014: ['WECHAT_TOKEN_INVALID', '接口凭据无效，请重新测试连接'],
    42001: ['WECHAT_TOKEN_EXPIRED', '接口凭据已过期，请重新测试连接'],
    48001: ['WECHAT_PERMISSION_REQUIRED', '当前公众号没有该接口权限，请在公众号后台核对'],
    40164: ['WECHAT_IP_NOT_ALLOWED', '当前网络出口 IP 不在公众号白名单中，请在微信开发者平台添加'],
    40007: ['WECHAT_MEDIA_NOT_FOUND', '草稿或素材不存在，可能已在公众号后台删除或发表'],
    40009: ['WECHAT_IMAGE_REJECTED', '微信拒绝了图片尺寸或大小，请更换图片'],
    40005: ['WECHAT_IMAGE_REJECTED', '微信不接受该图片格式，请使用 PNG 或 JPEG'],
    45009: ['WECHAT_RATE_LIMITED', '微信接口调用额度不足，请稍后再试'],
    45011: ['WECHAT_RATE_LIMITED', '微信接口调用过于频繁，请稍后再试'],
    89503: ['WECHAT_ADMIN_CONFIRMATION_REQUIRED', '本次连接需要公众号管理员确认'],
  };
  const [name, message] = messages[code] ?? ['WECHAT_API_REJECTED', `微信接口拒绝了请求（错误码 ${code}）`];
  // Never forward errmsg: it can contain access tokens, request URLs or secrets.
  const ip = code === 40164 && typeof remoteMessage === 'string'
    ? remoteMessage.match(/invalid ip\s+([\da-f:.]+)/i)?.[1] : undefined;
  return new WechatError(name, message, { apiCode: code, ...(ip ? { whitelistIp: ip } : {}) });
}

export function safeWechatError(error: unknown): WechatError {
  return error instanceof WechatError ? error : new WechatError('WECHAT_OPERATION_FAILED', '操作失败，请检查连接或本地数据后重试');
}
