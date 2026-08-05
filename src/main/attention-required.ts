import type { Platform } from '../shared/protocol.js';

export type AttentionCode = 'LOGIN_REQUIRED' | 'VERIFICATION_REQUIRED' | 'RISK_CONTROL_REQUIRED';

export interface AttentionRequired {
  platform: Platform;
  code: AttentionCode;
  message: string;
  url: string;
}

export class AttentionRequiredError extends Error {
  readonly code: AttentionCode;
  readonly details: AttentionRequired & { originalCode: string | null };

  constructor(attention: AttentionRequired, originalCode: string | null) {
    super(`${attention.code}: ${attention.message}`);
    this.code = attention.code;
    this.details = { ...attention, originalCode };
  }
}
