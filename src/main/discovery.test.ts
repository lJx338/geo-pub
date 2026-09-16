import { describe, expect, it } from 'vitest';
import { createDiscoveryRecord } from './discovery.js';

describe('discovery record', () => {
  it('contains runtime-derived locations without a fixed user name', () => {
    const record = createDiscoveryRecord('1.2.3', { launcherPath: '/dynamic/bin/geo-publisher', coreCliPath: '/dynamic/bin/versions/1.2.3/geo-publisher-core' }, true);
    expect(record).toMatchObject({ schemaVersion: 3, appVersion: '1.2.3', cliVersion: '1.2.3', protocolVersion: 1, skillVersion: '1.2.3', launcherPath: '/dynamic/bin/geo-publisher', coreCliPath: '/dynamic/bin/versions/1.2.3/geo-publisher-core', cliPath: '/dynamic/bin/geo-publisher', ready: true });
    expect(record.capabilities).toContain('draft.publish');
    expect(record.appPath).toBe(process.execPath);
    expect(record.controlEndpoint).toContain('geo-publisher-');
  });
});
