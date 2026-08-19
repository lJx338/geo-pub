import { describe, expect, it, vi } from 'vitest';
import { resumeVisibleDraft } from './editor-draft.js';

describe('visible draft recovery', () => {
  it('does nothing when the current page has no visible draft action', async () => {
    const webContents = {
      executeJavaScript: vi.fn().mockResolvedValue(null),
      sendInputEvent: vi.fn(),
    };
    await expect(resumeVisibleDraft(webContents as never)).resolves.toBe(false);
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('uses Chromium input events to enter the advertised draft', async () => {
    const webContents = {
      executeJavaScript: vi.fn()
        .mockResolvedValueOnce({ x: 120, y: 80 })
        .mockResolvedValueOnce(null),
      sendInputEvent: vi.fn(),
    };
    await expect(resumeVisibleDraft(webContents as never)).resolves.toBe(true);
    expect(webContents.sendInputEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'mouseDown', x: 120, y: 80 }));
    expect(webContents.sendInputEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'mouseUp', x: 120, y: 80 }));
  });
});
