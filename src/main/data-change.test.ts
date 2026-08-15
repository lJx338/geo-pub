import { describe, expect, it } from 'vitest';
import { DataChangeTracker } from './data-change.js';

describe('data change tracker', () => {
  it('assigns increasing revisions to committed workspace changes', () => {
    const tracker = new DataChangeTracker();
    const first = tracker.record({ entity: 'project', action: 'created', projectId: 'project-a', source: 'cli' });
    const second = tracker.record({ entity: 'content', action: 'saved', projectId: 'project-a', itemId: 'article-a', contentKind: 'article', source: 'desktop' });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(tracker.current()).toBe(2);
    expect(Date.parse(second.changedAt)).not.toBeNaN();
  });
});
