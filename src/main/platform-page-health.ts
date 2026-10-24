export type PlatformPageState = 'loading' | 'ready' | 'slow' | 'login_required' | 'error';

export interface PlatformPageHealth {
  state: PlatformPageState;
  message: string;
}

// This strip belongs to the workspace, above the native platform view.
export const PLATFORM_NOTICE_HEIGHT = 44;

/** Read-only probe. Never return form values, cookies or article content. */
export function readPlatformPageHealth(): PlatformPageHealth {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const notices = [...document.querySelectorAll('[role="dialog"],.el-message,.el-message-box,[class*="login"],[class*="Login"],[class*="passport"]')]
    .filter(visible).map((element) => element.textContent || '').join(' ');
  if (/发生未知错误|登录失败|验证码(?:错误|已过期|失效)/.test(notices)) {
    return { state: 'login_required', message: '登录或验证码校验未通过，请在平台内重新完成验证；若仍失败，请刷新登录页面。' };
  }
  if (/timeout|请求超时|网络异常/i.test(notices)) {
    return { state: 'slow', message: '平台请求超时，请稍后刷新；若正在登录，请重新完成验证码。' };
  }
  if (/账号不存在|登录已过期|登录失效|请重新登录/.test(notices)) {
    return { state: 'login_required', message: '平台未确认有效登录，请在下方重新登录并核验账号状态。' };
  }
  const loginPage = /(?:\/login|\/passport|\/signin|\/register)(?:[/?#]|$)/i.test(location.href)
    || [...document.querySelectorAll('input[type="password"]')].some(visible)
    || /扫码登录|手机登录|短信登录|登录\/注册/.test(notices);
  if (loginPage) return { state: 'login_required', message: '请在下方完成平台登录或验证码验证。' };
  const editorRoute = /\/rc\/edit|\/graphic\/publish|\/write(?:[/?#]|$)|\/creation\/article|\/addarticle|article-publish/.test(location.href);
  const fields = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
  const title = fields.find(element => /标题|title/i.test([
    element.getAttribute('placeholder'), element.getAttribute('data-placeholder'),
    element.getAttribute('aria-label'), element.className,
  ].join(' ')) || String(element.className).includes('FeEditorApp'));
  const body = fields.some(element => element !== title && element.matches('textarea,[contenteditable="true"],[role="textbox"]'))
    || [...document.querySelectorAll('iframe')].some(frame => {
      if (!visible(frame)) return false;
      try {
        const document = frame.contentDocument;
        return Boolean(document?.body?.isContentEditable || document?.querySelector('[contenteditable="true"],textarea,[role="textbox"]'));
      } catch { return false; }
    });
  if (editorRoute) {
    if (!title || !body) return { state: 'loading', message: '正在加载平台编辑器，请稍候…' };
    // An editor can contain a large article. Do not serialize its rendered
    // text (innerText also forces layout) on every readiness probe.
    return { state: 'ready', message: '标题和正文编辑器已显示，可以开始操作。' };
  }
  if (!document.body || !(document.body.innerText || '').trim()) return { state: 'loading', message: '正在加载平台内容…' };
  return { state: 'ready', message: '平台页面已显示，可以在下方操作。' };
}
