/**
 * Publisher dashboards can suppress the document's horizontal scrollbar even
 * when their fixed-width content is wider than the embedded browser. Restore
 * the native viewport scrollbar without resizing the page or its editors.
 * Keep vertical overflow and nested editor/dialog scrollers under site control.
 */
export const PLATFORM_HORIZONTAL_SCROLLBAR_THEME = `
  SCROLLER::-webkit-scrollbar:horizontal {
    display: block !important;
    height: 16px !important;
  }
  SCROLLER::-webkit-scrollbar-track:horizontal {
    background: #f1f1f1 !important;
    box-shadow: none !important;
    border: 0 !important;
  }
  SCROLLER::-webkit-scrollbar-thumb:horizontal {
    background: #999 !important;
    border: 2px solid #f1f1f1 !important;
    border-radius: 8px !important;
    box-shadow: none !important;
  }
  SCROLLER::-webkit-scrollbar-thumb:horizontal:hover { background: #707070 !important; }
  SCROLLER::-webkit-scrollbar-button:horizontal { display: none !important; width: 0 !important; }
`;

export const PLATFORM_SCROLLBAR_CSS = `
  html { overflow-x: auto !important; scrollbar-width: auto !important; scrollbar-color: auto !important; }
  body { overflow-x: visible !important; }
  ${PLATFORM_HORIZONTAL_SCROLLBAR_THEME.replaceAll('SCROLLER', 'html')}
`;

/** Runs inside the platform document; keep it independent of module scope. */
export function installPlatformHorizontalScrollbar(scrollbarTheme: string): void {
  const id = 'geo-platform-horizontal-scroll';
  if (document.getElementById(id)) return;
  const host = document.createElement('div');
  host.id = id;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    .bar { width:100%; height:16px; overflow-x:scroll; overflow-y:hidden;
      background:#f1f1f1; scrollbar-width:auto; scrollbar-color:auto; box-sizing:border-box; }
    ${scrollbarTheme.replaceAll('SCROLLER', '.bar')}
    .extent { height:1px; pointer-events:none; }
  </style><div class="bar" tabindex="0" role="region" aria-label="页面横向滚动条"><div class="extent"></div></div>`;
  for (const [property, value] of Object.entries({
    position: 'fixed', left: '0', right: '0', bottom: '0', height: '16px',
    'z-index': '2147483646', display: 'none', 'pointer-events': 'auto',
  })) host.style.setProperty(property, value, 'important');
  document.documentElement.append(host);
  const bar = shadow.querySelector<HTMLElement>('.bar')!;
  const extent = shadow.querySelector<HTMLElement>('.extent')!;
  let target: HTMLElement | null = null;
  let scheduled = 0;

  const syncFromPage = () => {
    if (target && Math.abs(bar.scrollLeft - target.scrollLeft) > 1) bar.scrollLeft = target.scrollLeft;
  };
  bar.addEventListener('scroll', () => {
    if (target && Math.abs(target.scrollLeft - bar.scrollLeft) > 1) target.scrollLeft = bar.scrollLeft;
  });
  const resizeObserver = new ResizeObserver(() => schedule());
  const update = () => {
    scheduled = 0;
    const root = document.documentElement;
    // The root already has the viewport scrollbar restored by our user CSS.
    // A body with overflow-y:scroll computes overflow-x:visible to auto and
    // traps horizontal overflow in a second scroller (e.g. mp.sohu.com).
    let next: HTMLElement | null = null;
    if (root.scrollWidth <= root.clientWidth + 1) {
      const candidates = [document.body, ...document.querySelectorAll<HTMLElement>('body *')];
      next = candidates.find(element => {
        if (!element || element === host || element.clientWidth < innerWidth * 0.5
          || element.clientHeight < Math.min(180, innerHeight * 0.4)
          || element.scrollWidth <= element.clientWidth + 1
          || element.closest('dialog,[role="dialog"],[contenteditable="true"],textarea,pre')) return false;
        const rect = element.getBoundingClientRect();
        if (rect.right < innerWidth * 0.5 || rect.left > innerWidth * 0.5 || rect.bottom <= 0 || rect.top >= innerHeight) return false;
        const style = getComputedStyle(element);
        return ['auto', 'scroll', 'hidden'].includes(style.overflowX) && style.visibility !== 'hidden';
      }) ?? null;
    }
    if (next !== target) {
      if (target) target.removeEventListener('scroll', syncFromPage);
      resizeObserver.disconnect();
      target = next;
      if (target) {
        target.addEventListener('scroll', syncFromPage, { passive: true });
        resizeObserver.observe(target);
      }
      resizeObserver.observe(root);
    }
    host.style.setProperty('display', target ? 'block' : 'none', 'important');
    if (target) {
      host.style.setProperty('right', `${Math.max(0, innerWidth - root.clientWidth)}px`, 'important');
      // Preserve the target's exact scroll range even for a narrower inner pane.
      extent.style.width = `${bar.clientWidth + target.scrollWidth - target.clientWidth}px`;
      syncFromPage();
    }
  };
  function schedule(): void {
    // Batch framework DOM updates; do not scan the page on every mutation.
    if (!scheduled) scheduled = window.setTimeout(update, 100);
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target !== host && !host.contains(record.target))) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  window.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('scroll', schedule, { passive: true, capture: true });
  resizeObserver.observe(document.documentElement);
  update();
}
