import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';
import { screen, type BrowserWindow, type WebContents } from 'electron';
import type { Platform, PublishTaskSnapshot } from '../shared/protocol.js';
import { diagnosticsDirectory } from './runtime-paths.js';

const MAX_CONSOLE_EVENTS = 80;
const MAX_CONSOLE_MESSAGE_LENGTH = 600;
const MAX_DIAGNOSTIC_SESSIONS = 20;
const DIAGNOSTIC_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface DiagnosticConsoleEvent {
  timestamp: string;
  level: number;
  message: string;
}

export function sanitizeDiagnosticMessage(value: string): string {
  return value
    .replace(/([?&](?:token|access_token|auth|authorization|session|cookie|code)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:bearer\s+)[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|accessToken|authorization|cookie|sessionId)\s*[:=]\s*["']?[^\s,"'}]+/gi, '$1: [REDACTED]')
    .replace(/("(?:html|content|body|text)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
    .replace(/\b[A-Za-z]:\\(?:[^\s,;]+\\)*[^\s,;]+/g, '[LOCAL_PATH]')
    .replace(/\/(?:Users|home|var|tmp)\/[^\s,;]+/g, '[LOCAL_PATH]')
    .slice(0, MAX_CONSOLE_MESSAGE_LENGTH);
}

export function appendDiagnosticConsoleEvent(
  events: DiagnosticConsoleEvent[],
  level: number,
  message: string,
  now = new Date(),
): void {
  events.push({ timestamp: now.toISOString(), level, message: sanitizeDiagnosticMessage(message) });
  if (events.length > MAX_CONSOLE_EVENTS) events.splice(0, events.length - MAX_CONSOLE_EVENTS);
}

function pageSnapshotScript(platform: Platform): string {
  return `(() => {
    const fingerprint = (value) => {
      const text = String(value || ''); let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    const descriptor = (element) => {
      if (!(element instanceof Element)) return null;
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(), id: String(element.id || '').slice(0, 80),
        className: String(element.className || '').slice(0, 240), role: element.getAttribute('role'),
        contenteditable: element.getAttribute('contenteditable'), placeholder: String(element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '').slice(0, 100),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    };
    const visible = (element) => element instanceof HTMLElement && (() => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const candidates = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"],.ql-editor,.ProseMirror,.public-DraftEditor-content')]
      .filter(visible).slice(0, 24).map((element) => {
        const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : String(element.textContent || '');
        const html = element instanceof HTMLElement ? element.innerHTML : '';
        const container = element.closest?.('.ql-container'); let quill = element.__quill || container?.__quill;
        try { quill ||= window.Quill?.find?.(element) || window.Quill?.find?.(container); } catch {}
        let quillState = null;
        try {
          const quillText = typeof quill?.getText === 'function' ? String(quill.getText() || '') : '';
          const ops = typeof quill?.getContents === 'function' ? quill.getContents()?.ops : [];
          quillState = { found: Boolean(quill), textLength: quillText.length, textFingerprint: fingerprint(quillText),
            ops: Array.isArray(ops) ? ops.slice(0, 80).map((op) => ({ insertType: typeof op?.insert, insertLength: typeof op?.insert === 'string' ? op.insert.length : 1, attributes: Object.keys(op?.attributes || {}).sort() })) : [] };
        } catch (error) { quillState = { found: Boolean(quill), error: String(error).slice(0, 160) }; }
        return { ...descriptor(element), textLength: text.length, textFingerprint: fingerprint(text), htmlLength: html.length,
          htmlFingerprint: fingerprint(html), structure: { blocks: element.querySelectorAll('[data-block="true"]').length, headings: element.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
            paragraphs: element.querySelectorAll('p').length, lists: element.querySelectorAll('ul,ol').length, quotes: element.querySelectorAll('blockquote').length,
            dividers: element.querySelectorAll('hr').length, images: element.querySelectorAll('img').length }, quill: quillState };
      });
    const selection = window.getSelection();
    return {
      platform: ${JSON.stringify(platform)}, url: location.origin + location.pathname,
      titleLength: document.title.length, titleFingerprint: fingerprint(document.title), readyState: document.readyState,
      viewport: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio, scrollX, scrollY },
      activeElement: descriptor(document.activeElement), selection: selection ? { rangeCount: selection.rangeCount, isCollapsed: selection.isCollapsed,
        anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset, anchor: descriptor(selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement) } : null,
      technologies: { draftJs: Boolean(document.querySelector('.public-DraftEditor-content,[data-block="true"]')), quill: Boolean(document.querySelector('.ql-editor,.ql-container')),
        prosemirror: Boolean(document.querySelector('.ProseMirror')), iframeCount: document.querySelectorAll('iframe').length },
      adapterTrace: window.__geoPublisherLastWrite || null,
      editors: candidates,
      dialogs: [...document.querySelectorAll('[role="dialog"],.el-dialog,.modal')].filter(visible).slice(0, 8).map((element) => ({ ...descriptor(element), textLength: String(element.textContent || '').length, textFingerprint: fingerprint(element.textContent) })),
    };
  })()`;
}

export interface FailureDiagnosticInput {
  task: PublishTaskSnapshot;
  errorMessage: string;
  errorCode?: string;
  webContents?: WebContents;
  window: BrowserWindow;
  version: string;
  consoleEvents: DiagnosticConsoleEvent[];
  evidencePath?: string;
  automationActions?: unknown;
}

export async function captureFailureDiagnostic(input: FailureDiagnosticInput): Promise<string> {
  let page: unknown = { captureError: 'renderer unavailable' };
  if (input.webContents && !input.webContents.isDestroyed()) {
    try { page = await input.webContents.executeJavaScript(pageSnapshotScript(input.task.platform)); }
    catch (error) { page = { captureError: error instanceof Error ? error.message : String(error) }; }
  }
  const display = screen.getDisplayMatching(input.window.getBounds());
  const diagnostic = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    app: { version: input.version, platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome },
    task: { taskId: input.task.taskId, platform: input.task.platform, action: input.task.action, phase: input.task.phase,
      startedAt: input.task.startedAt, titleFingerprint: input.task.title ? createHash('sha256').update(input.task.title).digest('hex').slice(0, 16) : null },
    failure: { code: input.errorCode || null, message: sanitizeDiagnosticMessage(input.errorMessage) },
    window: { visible: input.window.isVisible(), focused: input.window.isFocused(), minimized: input.window.isMinimized(),
      bounds: input.window.getBounds(), contentSize: input.window.getContentSize(), display: { scaleFactor: display.scaleFactor, bounds: display.bounds, workArea: display.workArea } },
    page,
    consoleEvents: input.consoleEvents.slice(-MAX_CONSOLE_EVENTS),
    automationActions: input.automationActions || [],
    evidenceFile: input.evidencePath ? basename(input.evidencePath) : null,
    privacy: 'Structured JSON excludes cookies, tokens, localStorage values, article body text, title text, and cover files. An included evidence screenshot may show the visible editor page.',
  };
  const directory = join(diagnosticsDirectory(), input.task.taskId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'diagnostic.json');
  await writeFile(path, JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
  await pruneDiagnostics();
  return path;
}

export async function exportDiagnosticBundle(task: PublishTaskSnapshot): Promise<{ path: string; fileName: string }> {
  if (!task.diagnosticPath) throw new Error('DIAGNOSTIC_NOT_AVAILABLE: 这条记录没有可导出的诊断信息');
  const diagnosticPath = resolve(task.diagnosticPath);
  const root = `${resolve(diagnosticsDirectory())}${sep}`;
  if (!diagnosticPath.startsWith(root)) throw new Error('DIAGNOSTIC_PATH_INVALID: 诊断路径无效');
  const zip = new AdmZip();
  zip.addFile('task.json', Buffer.from(JSON.stringify({ taskId: task.taskId, platform: task.platform, action: task.action, phase: task.phase,
    status: task.status, startedAt: task.startedAt, finishedAt: task.finishedAt, elapsedMs: task.elapsedMs, errorCode: task.errorCode,
    message: task.message ? sanitizeDiagnosticMessage(task.message) : undefined, titleFingerprint: task.title ? createHash('sha256').update(task.title).digest('hex').slice(0, 16) : undefined }, null, 2)));
  zip.addFile('diagnostic.json', await readFile(diagnosticPath));
  if (task.evidencePath) {
    try { zip.addFile(`evidence/${basename(task.evidencePath)}`, await readFile(task.evidencePath)); } catch { /* Screenshot is best effort. */ }
  }
  const fileName = `GEO-Publisher-${task.platform}-${task.taskId.slice(0, 8)}-diagnostic.zip`;
  const exportRoot = join(tmpdir(), 'geo-publisher-diagnostic-exports');
  await mkdir(exportRoot, { recursive: true });
  const path = join(exportRoot, `${Date.now()}-${fileName}`);
  await new Promise<void>((resolveWrite, rejectWrite) => zip.writeZip(path, (error) => error ? rejectWrite(error) : resolveWrite()));
  return { path, fileName };
}

export async function removeTaskDiagnostic(taskId: string): Promise<void> {
  await rm(join(diagnosticsDirectory(), taskId), { recursive: true, force: true });
}

export async function pruneDiagnostics(now = Date.now()): Promise<void> {
  let entries: string[];
  try { entries = await readdir(diagnosticsDirectory()); } catch { return; }
  const sessions = (await Promise.all(entries.map(async (name) => {
    try { return { name, modifiedAt: (await stat(join(diagnosticsDirectory(), name))).mtimeMs }; } catch { return null; }
  }))).filter((entry): entry is { name: string; modifiedAt: number } => Boolean(entry)).sort((left, right) => right.modifiedAt - left.modifiedAt);
  await Promise.all(sessions.filter((entry, index) => index >= MAX_DIAGNOSTIC_SESSIONS || entry.modifiedAt < now - DIAGNOSTIC_MAX_AGE_MS)
    .map(async (entry) => await rm(join(diagnosticsDirectory(), entry.name), { recursive: true, force: true })));
}
