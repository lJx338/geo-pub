export interface WorkerWindowVisibilityTarget {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  setSkipTaskbar(skip: boolean): void;
  show(): void;
  showInactive(): void;
  moveTop(): void;
  focus(): void;
  setAlwaysOnTop(flag: boolean): void;
  hide(): void;
}

export function revealWorkerWindow(
  window: WorkerWindowVisibilityTarget,
  showInTaskbar = false,
  focus = true,
): void {
  if (window.isDestroyed()) return;
  if (showInTaskbar) window.setSkipTaskbar(false);
  if (window.isMinimized()) window.restore();
  if (!focus) {
    window.showInactive();
    return;
  }
  if (showInTaskbar) window.setAlwaysOnTop(true);
  window.show();
  window.moveTop();
  window.focus();
  if (showInTaskbar) window.setAlwaysOnTop(false);
}

export function concealWorkerWindow(
  window: WorkerWindowVisibilityTarget,
  hideFromTaskbar = false,
): void {
  if (window.isDestroyed()) return;
  window.hide();
  if (hideFromTaskbar) window.setSkipTaskbar(true);
}
