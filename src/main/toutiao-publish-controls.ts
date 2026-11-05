import type { WebContents } from 'electron';

export interface ToutiaoPublishControls {
  adDialogVisible: boolean;
  previewVisible: boolean;
  confirmationAvailable: boolean;
  point: { x: number; y: number } | null;
  reason: string;
}

/** Runs in Chromium. A button's dimensions alone do not prove that the
 * preview is open or that the button is above the advertising confirmation. */
export async function readToutiaoPublishControls(
  phase: 'inspect' | 'ad' | 'confirmation' = 'inspect',
  sessionId = '',
): Promise<ToutiaoPublishControls> {
  const host = window as typeof window & { __geoToutiaoPublish?: { id: string; adRoots: Set<HTMLElement> } };
  if (host.__geoToutiaoPublish?.id !== sessionId) host.__geoToutiaoPublish = { id: sessionId, adRoots: new Set() };
  const session = host.__geoToutiaoPublish;
  const normalize = (value: string | null) => (value || '').replace(/\s+/g, ' ').trim();
  const editor = '[contenteditable="true"],textarea,input';
  const rendered = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
        || node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  const exposed = (element: HTMLElement) => {
    if (!rendered(element)) return false;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === element || element.contains(hit));
  };
  const enabled = (element: HTMLElement) => !element.matches(':disabled')
    && !element.closest('[disabled],[aria-disabled="true"]')
    && getComputedStyle(element).pointerEvents !== 'none';
  const collect = () => {
    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .filter(rendered).filter(element => !element.closest(editor));
    const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"]')]
      .filter(rendered).filter(element => !element.closest(editor) && !element.querySelector('[contenteditable="true"],textarea'));
    // Match the meaning, not a specific quotation mark or uninterrupted text.
    const matchedAds = dialogs.filter(element => {
      const text = normalize(element.innerText).replace(/\s/g, '');
      return text.includes('不投放广告') && text.includes('不会产生广告收益');
    });
    const withButton = matchedAds.filter(dialog => buttons.some(button => normalize(button.textContent) === '确定' && dialog.contains(button)));
    const roots = withButton.length ? withButton : matchedAds;
    roots.filter(root => !roots.some(other => other !== root && root.contains(other)))
      .forEach(element => session.adRoots.add(element));
    // A changed message is not proof of closure. Keep tracking the actual
    // observed dialog until its DOM is removed or hidden, including ancestors.
    const adDialogs = [...session.adRoots].filter(element => element.isConnected && rendered(element));
    const adButtons = buttons.filter(button => normalize(button.textContent) === '确定'
      && adDialogs.some(dialog => dialog.contains(button)));
    // These are the two distinct preview labels in Toutiao's phone preview,
    // not mentions in the underlying article or hidden pre-rendered markup.
    const labels = [...document.querySelectorAll('label,span,p,div')]
      .filter(rendered).filter(element => !element.closest(editor));
    const previewVisible = ['屏幕尺寸', '手机预览'].every(text => labels.some(element =>
      normalize(element.textContent) === text && exposed(element)))
      && buttons.some(button => normalize(button.textContent) === '返回编辑' && exposed(button));
    const confirmations = buttons.filter(button => normalize(button.textContent) === '确认发布' && enabled(button) && exposed(button));
    return { adDialogs, adButtons, previewVisible, confirmations };
  };
  let controls = collect();
  const result = (point: ToutiaoPublishControls['point'] = null, reason = 'inspect'): ToutiaoPublishControls => ({
    adDialogVisible: controls.adDialogs.length > 0,
    previewVisible: controls.previewVisible,
    confirmationAvailable: controls.adDialogs.length === 0 && controls.previewVisible && controls.confirmations.length === 1,
    point, reason,
  });
  if (phase === 'inspect') return result();
  if (phase === 'confirmation' && controls.adDialogs.length) return result(null, 'ad_dialog_open');
  if (phase === 'confirmation' && !controls.previewVisible) return result(null, 'preview_not_ready');
  const candidates = phase === 'ad' ? controls.adButtons.filter(enabled) : controls.confirmations;
  if (candidates.length !== 1) return result(null, candidates.length ? 'ambiguous' : 'missing');
  const button = candidates[0]!;
  button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  await new Promise(resolve => setTimeout(resolve, 100));
  controls = collect();
  if (phase === 'confirmation' && (controls.adDialogs.length || !controls.previewVisible
    || controls.confirmations.length !== 1 || controls.confirmations[0] !== button)) return result(null, 'preview_not_ready');
  if (phase === 'ad' && (controls.adButtons.length !== 1 || controls.adButtons[0] !== button)) return result(null, 'dialog_changed');
  if (!button.isConnected || !enabled(button) || !exposed(button)) return result(null, 'covered');
  const rect = button.getBoundingClientRect();
  return result({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, 'ready');
}

export async function inspectToutiaoPublishControls(webContents: WebContents, sessionId: string): Promise<ToutiaoPublishControls> {
  return await webContents.executeJavaScript(`(${readToutiaoPublishControls.toString()})('inspect', ${JSON.stringify(sessionId)})`);
}

export async function clickToutiaoPublishControl(webContents: WebContents, phase: 'ad' | 'confirmation', sessionId: string): Promise<boolean> {
  const state: ToutiaoPublishControls = await webContents.executeJavaScript(`(${readToutiaoPublishControls.toString()})(${JSON.stringify(phase)}, ${JSON.stringify(sessionId)})`);
  if (!state.point) return false;
  // Chromium rects are CSS pixels; Electron input events use view coordinates.
  // Native input also reaches handlers that ignore synthetic element.click().
  const zoom = webContents.getZoomFactor();
  const x = Math.round(state.point.x * zoom);
  const y = Math.round(state.point.y * zoom);
  webContents.sendInputEvent({ type: 'mouseMove', x, y });
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  return true;
}
