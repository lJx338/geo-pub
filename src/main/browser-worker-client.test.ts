import { describe, expect, it } from 'vitest';
import { BrowserWorkerClient } from './browser-worker-client.js';

describe('browser worker lifecycle state', () => {
  it('drops a stale busy snapshot when the worker becomes unavailable', () => {
    const client = new BrowserWorkerClient('0.2.4');
    const internals = client as unknown as {
      latestStatus: { busy: boolean; activeTask: { action: string } | null } | null;
      markUnavailable: (error: string | null) => void;
    };
    internals.latestStatus = { busy: true, activeTask: { action: 'fill' } };

    internals.markUnavailable('Worker 已退出');

    expect(internals.latestStatus).toBeNull();
    expect(client.isBusy()).toBe(false);
    expect(client.workerHealth()).toMatchObject({ state: 'unavailable', lastError: 'Worker 已退出' });
  });
});
