import type { Platform } from '../shared/protocol.js';

export const BROWSER_WORKER_PROTOCOL_VERSION = 2;
export const BROWSER_WORKER_TOKEN_ENV = 'GEO_BROWSER_WORKER_TOKEN';
export const BROWSER_WORKER_ENDPOINT_ENV = 'GEO_BROWSER_WORKER_ENDPOINT';
export const BROWSER_WORKER_PROTOCOL_ENV = 'GEO_BROWSER_WORKER_PROTOCOL';
export const BROWSER_WORKER_APP_VERSION_ENV = 'GEO_BROWSER_WORKER_APP_VERSION';

export type BrowserWorkerAction =
  | 'status'
  | 'platform.open'
  | 'platform.inspect'
  | 'draft.fill'
  | 'draft.publish'
  | 'shutdown';

export interface BrowserWorkerRequest {
  id: string;
  token: string;
  protocolVersion: number;
  appVersion: string;
  action: BrowserWorkerAction;
  payload?: {
    platform?: Platform;
    title?: string;
    html?: string;
    coverPath?: string;
    tags?: string[];
  };
}

export interface BrowserWorkerResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface BrowserWorkerHealth {
  state: 'starting' | 'ready' | 'unavailable';
  pid: number | null;
  protocolVersion: number;
  lastError: string | null;
}
