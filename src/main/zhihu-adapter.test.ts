import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeZhihuEditorText, verifyZhihuDraftState, waitForEditorCommit } from './zhihu-adapter.js';

describe('Zhihu draft verification', () => {
  it('accepts three stable editor samples when the delayed word count is still zero', () => {
    expect(verifyZhihuDraftState({
      titleFilled: true,
      bodyFilled: true,
      stableSamples: 3,
      wordCount: 0,
      expectedTextLength: 800,
    })).toEqual({ verified: true, source: 'stable_editor' });
  });

  it('prefers the platform word count when it has caught up', () => {
    expect(verifyZhihuDraftState({
      titleFilled: true,
      bodyFilled: true,
      stableSamples: 1,
      wordCount: 600,
      expectedTextLength: 800,
    })).toEqual({ verified: true, source: 'word_count' });
  });

  it('never accepts missing, partial, or unstable editor content', () => {
    expect(verifyZhihuDraftState({ titleFilled: true, bodyFilled: false, stableSamples: 3, wordCount: 0, expectedTextLength: 800 }).verified).toBe(false);
    expect(verifyZhihuDraftState({ titleFilled: true, bodyFilled: true, stableSamples: 2, wordCount: 0, expectedTextLength: 800 }).verified).toBe(false);
    expect(verifyZhihuDraftState({ titleFilled: false, bodyFilled: true, stableSamples: 3, wordCount: 800, expectedTextLength: 800 }).verified).toBe(false);
  });
});

describe('Zhihu editor input recovery', () => {
  afterEach(() => vi.useRealTimers());

  const committed = { ready: true, focused: true, selectionInEditor: true, text: '完整正文' };

  it.each([
    { focused: false, selectionInEditor: true },
    { focused: true, selectionInEditor: false },
  ])('restores a lost caret after text is committed without replaying input: %j', async (lostCaret) => {
    vi.useFakeTimers();
    const webContents = {
      executeJavaScript: vi.fn()
        .mockResolvedValueOnce({ ...committed, ...lostCaret })
        .mockResolvedValueOnce({ ready: true, restore: true })
        .mockResolvedValueOnce({ ready: true, restore: false })
        .mockResolvedValue(committed),
      debugger: { isAttached: () => true, sendCommand: vi.fn().mockResolvedValue(undefined) },
    };
    const completion = waitForEditorCommit(webContents as never, '完整正文');
    await vi.runAllTimersAsync();
    await expect(completion).resolves.toBeUndefined();
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({
      commands: ['moveToEndOfDocument'],
    }));
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
  });

  it('keeps waiting for delayed text after focus has recovered', async () => {
    vi.useFakeTimers();
    const webContents = {
      executeJavaScript: vi.fn()
        .mockResolvedValueOnce({ ...committed, focused: false, text: '' })
        .mockResolvedValueOnce({ ready: true, restore: true })
        .mockResolvedValueOnce({ ready: true, restore: false })
        .mockResolvedValueOnce({ ...committed, text: '完整' })
        .mockResolvedValue(committed),
      debugger: { isAttached: () => true, sendCommand: vi.fn().mockResolvedValue(undefined) },
    };
    const completion = waitForEditorCommit(webContents as never, '完整正文');
    await vi.runAllTimersAsync();
    await expect(completion).resolves.toBeUndefined();
  });

  it('still rejects a partially inserted paragraph even when the editor is focused', async () => {
    vi.useFakeTimers();
    const webContents = { executeJavaScript: vi.fn().mockResolvedValue({ ...committed, text: '完整' }) };
    const failure = waitForEditorCommit(webContents as never, '完整正文', 500).catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({ message: expect.stringContaining('ZHIHU_EDITOR_COMMIT_TIMEOUT:') });
  });

  it('does not accept text that keeps changing', async () => {
    vi.useFakeTimers();
    let samples = 0;
    const webContents = { executeJavaScript: vi.fn(async () => ({ ...committed, text: `完整正文${samples++}` })) };
    const failure = waitForEditorCommit(webContents as never, '完整正文', 500).catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({ message: expect.stringContaining('ZHIHU_EDITOR_COMMIT_TIMEOUT:') });
  });

  it('reports an unrecoverable caret separately from a content commit timeout', async () => {
    vi.useFakeTimers();
    const webContents = {
      executeJavaScript: vi.fn()
        .mockResolvedValueOnce({ ...committed, selectionInEditor: false })
        .mockResolvedValue({ ready: false, restore: false }),
    };
    const failure = waitForEditorCommit(webContents as never, '完整正文').catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({ message: expect.stringContaining('ZHIHU_EDITOR_FOCUS_LOST:') });
  });
});

describe('Zhihu text normalization', () => {
  it('preserves English s characters and normalizes spaces in the injected page function', () => {
    const injectedNormalize = new Function(`return (${normalizeZhihuEditorText.toString()});`)() as typeof normalizeZhihuEditorText;
    expect(injectedNormalize('  stress\tcompression\n密封\u00a0条\u200b  ')).toBe('stress compression 密封 条');
    expect(injectedNormalize('class, CSS, stress-test')).toBe('class, CSS, stress-test');
  });
});
