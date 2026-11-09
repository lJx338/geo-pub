import type { WebContents } from 'electron';

export interface ToutiaoPublishControls {
  adDialogVisible: boolean;
  adDialogCount: number;
  adButtonCount: number;
  adReadyButtonCount: number;
  adDetection: 'none' | 'marked' | 'semantic' | 'tracked';
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
  const normalize = (value: string | null) => (value || '').replace(/[\s\u200b-\u200d\ufeff]/g, '');
  const editable = '[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"],textarea';
  const editor = `${editable},input`;
  const rendered = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      // aria-hidden controls accessibility, not whether Chromium draws a
      // popup. Likewise inert content is visible even while input is blocked.
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || Number(style.opacity) === 0 || node.hidden) return false;
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
    && !element.closest('[disabled],[aria-disabled="true"],[inert]')
    && getComputedStyle(element).pointerEvents !== 'none';
  const collect = () => {
    const nativeButtons = [...document.querySelectorAll('button,[role="button"]')]
      .filter(rendered).filter(element => !element.closest(editor));
    // Some variants use clickable divs/spans instead of semantic buttons.
    // Only accept exact control labels and deduplicate nested label wrappers.
    const customButtons = [...document.querySelectorAll('a,div,span')]
      .filter(rendered).filter(element => !element.closest(editor))
      .filter(element => ['确定', '取消', '返回编辑', '确认发布'].includes(normalize(element.textContent)))
      .filter(element => element.tabIndex >= 0 || typeof element.onclick === 'function'
        || getComputedStyle(element).cursor === 'pointer')
      .filter(element => !nativeButtons.some(button => button.contains(element) || element.contains(button)));
    const buttons = [...nativeButtons, ...customButtons.filter(element =>
      !customButtons.some(other => other !== element && other.contains(element)))];
    const isAdNotice = (element: HTMLElement) => {
      const text = normalize(element.innerText);
      return text.includes('不投放广告') && text.includes('不会产生广告收益');
    };
    const outsideEditor = (element: HTMLElement) => !element.closest(editor)
      && !element.querySelector(editable);
    const dialogs = [...document.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"],[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"]')]
      .filter(rendered).filter(outsideEditor);
    // Match the meaning, not a specific quotation mark or uninterrupted text.
    const matchedAds = dialogs.filter(isAdNotice);
    // Some platform variants render a popup without dialog roles or class
    // names. Recognize its message and controls inside a positioned overlay,
    // rather than treating unrelated article/settings text as a confirmation.
    const semanticDialogs = [...document.querySelectorAll('div,section,aside,dialog')]
      .filter(rendered).filter(outsideEditor).filter(isAdNotice)
      .filter(element => buttons.some(button => normalize(button.textContent) === '取消' && element.contains(button)))
      .filter(element => buttons.some(button => normalize(button.textContent) === '确定' && element.contains(button))
        || [...element.querySelectorAll('h1,h2,h3,div,span')].some(label => rendered(label) && normalize(label.textContent) === '提示'))
      .filter(element => {
        for (let node: HTMLElement | null = element; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.position === 'fixed' || (style.position === 'absolute' && Number(style.zIndex) > 0)) return true;
        }
        return false;
      });
    const roots = [...new Set([...matchedAds, ...semanticDialogs])];
    roots.filter(root => !roots.some(other => other !== root && root.contains(other)))
      .forEach(element => session.adRoots.add(element));
    // A changed message is not proof of closure. Keep tracking the actual
    // observed dialog until its DOM is removed or hidden, including ancestors.
    // Removed/hidden roots no longer describe the active confirmation episode.
    for (const root of session.adRoots) if (!root.isConnected || !rendered(root)) session.adRoots.delete(root);
    const adDialogs = [...session.adRoots];
    const adButtons = buttons.filter(button => normalize(button.textContent) === '确定'
      && adDialogs.some(dialog => dialog.contains(button)));
    const adReadyButtons = adButtons.filter(button => enabled(button) && exposed(button));
    const adDetection: ToutiaoPublishControls['adDetection'] = matchedAds.length ? 'marked'
      : semanticDialogs.length ? 'semantic' : adDialogs.length ? 'tracked' : 'none';
    // These are the two distinct preview labels in Toutiao's phone preview,
    // not mentions in the underlying article or hidden pre-rendered markup.
    const labels = [...document.querySelectorAll('label,span,p,div')]
      .filter(rendered).filter(element => !element.closest(editor));
    const previewVisible = ['屏幕尺寸', '手机预览'].every(text => labels.some(element =>
      normalize(element.textContent) === text && exposed(element)))
      && buttons.some(button => normalize(button.textContent) === '返回编辑' && exposed(button));
    const confirmations = buttons.filter(button => normalize(button.textContent) === '确认发布' && enabled(button) && exposed(button));
    return { adDialogs, adButtons, adReadyButtons, adDetection, previewVisible, confirmations };
  };
  let controls = collect();
  const result = (point: ToutiaoPublishControls['point'] = null, reason = controls.adDialogs.length
    ? (controls.adButtons.length === 0 ? 'ad_button_missing' : controls.adButtons.length > 1 ? 'ad_button_ambiguous'
      : controls.adReadyButtons.length === 0 ? 'ad_button_unavailable' : 'ad_ready')
    : !controls.previewVisible ? 'preview_not_ready' : controls.confirmations.length !== 1 ? 'confirmation_unavailable' : 'preview_ready'): ToutiaoPublishControls => ({
    adDialogVisible: controls.adDialogs.length > 0,
    adDialogCount: controls.adDialogs.length,
    adButtonCount: controls.adButtons.length,
    adReadyButtonCount: controls.adReadyButtons.length,
    adDetection: controls.adDetection,
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

export async function clickToutiaoPublishControl(webContents: WebContents, phase: 'ad' | 'confirmation', sessionId: string): Promise<ToutiaoPublishControls & { clicked: boolean }> {
  const state: ToutiaoPublishControls = await webContents.executeJavaScript(`(${readToutiaoPublishControls.toString()})(${JSON.stringify(phase)}, ${JSON.stringify(sessionId)})`);
  if (!state.point) return { ...state, clicked: false };
  // Chromium rects are CSS pixels; Electron input events use view coordinates.
  // Native input also reaches handlers that ignore synthetic element.click().
  const zoom = webContents.getZoomFactor();
  const x = Math.round(state.point.x * zoom);
  const y = Math.round(state.point.y * zoom);
  webContents.sendInputEvent({ type: 'mouseMove', x, y });
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  return { ...state, clicked: true };
}
