import type { WebContents } from 'electron';
import { cdpClick } from './browser-automation-driver.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Enter the draft advertised above an otherwise empty editor before overwriting it. */
export async function resumeVisibleDraft(webContents: WebContents): Promise<boolean> {
  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = await webContents.executeJavaScript(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => element instanceof HTMLElement && (() => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      })();
      const target = [...document.querySelectorAll('button,a,[role="button"]')]
        .filter(visible)
        .find((element) => ['继续编辑', '编辑草稿'].includes(normalize(element.textContent)));
      if (!(target instanceof HTMLElement)) return null;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) return clicked;
    await cdpClick(webContents, { x: Math.round(point.x), y: Math.round(point.y) });
    clicked = true;
    await delay(900 + attempt * 400);
  }
  return clicked;
}
