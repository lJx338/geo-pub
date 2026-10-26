export interface ZhihuPublishClick {
  clicked: boolean;
  reason: 'clicked' | 'missing' | 'ambiguous' | 'covered' | 'already_clicked' | 'no_session';
}

/** Runs in the platform renderer. Keep this function self-contained for serialization. */
export async function clickZhihuPublishControl(
  sessionId: string,
  phase: 'primary' | 'confirmation',
): Promise<ZhihuPublishClick> {
  type Session = {
    id: string;
    primary: HTMLElement;
    baseline: Set<string>;
    primaryClicked: boolean;
    confirmationClicked: boolean;
  };
  const host = window as typeof window & { __geoZhihuPublish?: Session };
  const normalize = (value: string | null) => (value || '').replace(/\s+/g, ' ').trim();
  const editorSelector = '[contenteditable="true"],.DraftEditor-root,textarea,input';
  const visible = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none'
      && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
  };
  // Do not depend on Zhihu using role=dialog or a particular Modal class.
  // A bounded panel with publishing labels is also a confirmation surface.
  const context = (button: HTMLElement): string | null => {
    for (let root = button.parentElement; root && root !== document.body; root = root.parentElement) {
      if (root.querySelector('[contenteditable="true"],.DraftEditor-root,textarea[placeholder*="标题"]')) break;
      const text = normalize(root.innerText);
      if (text.length > 2000) break;
      const dialog = root.matches('[role="dialog"],[class*="Modal"],[class*="modal"],[class*="Dialog"],[class*="dialog"]');
      const labels = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,[role="heading"],label,div,span,p')]
        .filter(element => !element.closest('button,[role="button"]') && !element.contains(button))
        .map(element => normalize(element.textContent))
        .filter(value => ['发布设置', '创作声明', '确认发布', '确定发布'].includes(value));
      if (dialog || labels.length || /^(确认发布|确定发布)$/.test(normalize(button.textContent))) {
        return `${root.tagName}:${dialog ? 'dialog' : [...new Set(labels)].sort().join(',')}`;
      }
    }
    return null;
  };
  const controls = () => [...document.querySelectorAll<HTMLElement>('button,[role="button"]')]
    .filter(element => !element.closest(editorSelector) && visible(element))
    .filter(element => ['发布', '确认发布', '确定发布'].includes(normalize(element.textContent)));
  // Ignore transient classes/IDs: replacing a toolbar button while saving
  // must not make it look like a newly revealed confirmation step.
  const signature = (button: HTMLElement) => `${context(button) || 'page'}|${normalize(button.textContent)}`;
  const enabled = (button: HTMLElement) => !button.matches(':disabled')
    && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true';
  let session = host.__geoZhihuPublish;
  if (session?.id === sessionId && (phase === 'primary' ? session.primaryClicked : session.confirmationClicked)) {
    return { clicked: false, reason: 'already_clicked' };
  }
  if (phase === 'confirmation' && (!session || session.id !== sessionId || !session.primaryClicked)) {
    return { clicked: false, reason: 'no_session' };
  }
  const all = controls();
  const candidates = all.filter(enabled).filter(button => phase === 'primary'
    ? normalize(button.textContent) === '发布'
    : button !== session!.primary && context(button) !== null && !session!.baseline.has(signature(button)));
  if (!candidates.length) return { clicked: false, reason: 'missing' };
  if (candidates.length !== 1) return { clicked: false, reason: 'ambiguous' };
  const button = candidates[0]!;
  button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  button.focus({ preventScroll: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  if (!button.isConnected || !visible(button) || !enabled(button)) return { clicked: false, reason: 'missing' };
  const rect = button.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit || (hit !== button && !button.contains(hit))) return { clicked: false, reason: 'covered' };
  if (phase === 'primary') {
    session = { id: sessionId, primary: button, baseline: new Set(controls().map(signature)), primaryClicked: false, confirmationClicked: false };
    host.__geoZhihuPublish = session;
  }
  // Mark before dispatch: a synchronous rerender or navigation must not allow
  // another submission. DOM activation avoids CSS-pixel/native zoom mismatch.
  if (phase === 'primary') session!.primaryClicked = true;
  else session!.confirmationClicked = true;
  button.click();
  return { clicked: true, reason: 'clicked' };
}
