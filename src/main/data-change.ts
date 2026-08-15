import type { DataChangeEvent } from '../shared/protocol.js';

export class DataChangeTracker {
  private revision = 0;

  current(): number { return this.revision; }

  record(change: Omit<DataChangeEvent, 'revision' | 'changedAt'>): DataChangeEvent {
    return {
      ...change,
      revision: ++this.revision,
      changedAt: new Date().toISOString(),
    };
  }
}
