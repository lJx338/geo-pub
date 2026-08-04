import { describe, expect, it } from 'vitest';
import { createDiscoveryRecord } from './discovery.js';

describe('discovery record', () => {
  it('contains runtime-derived locations without a fixed user name', () => {
    const record = createDiscoveryRecord('1.2.3', '/dynamic/bin/geo-publisher', true);
    expect(record).toMatchObject({ schemaVersion: 1, appVersion: '1.2.3', cliPath: '/dynamic/bin/geo-publisher', ready: true });
    expect(record.appPath).toBe(process.execPath);
    expect(record.controlEndpoint).toContain('geo-publisher-');
  });
});
