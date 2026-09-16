export interface WorkerRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkerSize {
  width: number;
  height: number;
}

export const PREFERRED_WORKER_WINDOW_SIZE: WorkerSize = { width: 1440, height: 1000 };

export function fitWorkerWindowToWorkArea(
  workArea: WorkerRectangle,
  preferred: WorkerSize = PREFERRED_WORKER_WINDOW_SIZE,
): WorkerRectangle {
  const width = Math.max(1, Math.min(preferred.width, workArea.width));
  const height = Math.max(1, Math.min(preferred.height, workArea.height));
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
  };
}

export function constrainWorkerWindowToWorkArea(
  bounds: WorkerRectangle,
  workArea: WorkerRectangle,
): WorkerRectangle {
  const width = Math.max(1, Math.min(bounds.width, workArea.width));
  const height = Math.max(1, Math.min(bounds.height, workArea.height));
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

export function automationViewportForView(bounds: Pick<WorkerRectangle, 'width' | 'height'>): WorkerSize {
  return {
    width: Math.max(1, Math.floor(bounds.width)),
    height: Math.max(1, Math.floor(bounds.height)),
  };
}
