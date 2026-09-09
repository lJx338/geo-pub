import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import { appendDiagnosticConsoleEvent, installEditorDiagnostics, sanitizeDiagnosticMessage, type DiagnosticConsoleEvent } from './diagnostic-bundle.js';

describe('failure diagnostic privacy', () => {
  it('redacts credentials from renderer messages', () => {
    const message = sanitizeDiagnosticMessage('GET /callback?token=secret&code=abc Bearer real.jwt token=plain cookie: session-value C:\\Users\\Alice\\cover.png {"body":"article text"}');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('real.jwt');
    expect(message).not.toContain('plain');
    expect(message).not.toContain('session-value');
    expect(message).not.toContain('Alice');
    expect(message).not.toContain('article text');
    expect(message).toContain('[REDACTED]');
  });

  it('keeps only the most recent bounded renderer events', () => {
    const events: DiagnosticConsoleEvent[] = [];
    for (let index = 0; index < 100; index += 1) {
      appendDiagnosticConsoleEvent(events, 2, `failure-${index}`, new Date(index));
    }
    expect(events).toHaveLength(80);
    expect(events[0]?.message).toBe('failure-20');
    expect(events.at(-1)?.message).toBe('failure-99');
  });

  it('records event delivery and editor structure without retaining article text', async () => {
    let script = '';
    const webContents = {
      isDestroyed: () => false,
      executeJavaScript: async (value: string) => { script = value; return true; },
    } as unknown as WebContents;
    await installEditorDiagnostics(webContents);
    expect(script).toContain("'keydown','keyup','beforeinput','input','mousedown','click'");
    expect(script).toContain('trusted: Boolean(event.isTrusted)');
    expect(script).toContain('defaultPrevented');
    expect(script).toContain('activeBlockType');
    expect(script).toContain('editorTextFingerprint');
    expect(script).not.toContain('editorText: text');
  });
});
