import { describe, expect, it } from 'vitest';
import { captureSuccessfulEvidence, captureUncertainEvidence, evidenceMode } from './evidence-policy.js';

describe('evidence policy', () => {
  it('defaults to minimal for customer installations', () => {
    expect(evidenceMode({})).toBe('minimal');
    expect(captureSuccessfulEvidence({})).toBe(false);
  });

  it('allows standard and debug evidence for beta and development runs', () => {
    expect(evidenceMode({ GEO_EVIDENCE_MODE: 'standard' })).toBe('standard');
    expect(evidenceMode({ GEO_EVIDENCE_MODE: 'debug' })).toBe('debug');
    expect(captureSuccessfulEvidence({ GEO_EVIDENCE_MODE: 'standard' })).toBe(true);
  });

  it('falls back to minimal for invalid configuration', () => {
    expect(evidenceMode({ GEO_EVIDENCE_MODE: 'verbose' })).toBe('minimal');
  });

  it('always captures uncertain outcomes', () => {
    expect(captureUncertainEvidence('success')).toBe(false);
    expect(captureUncertainEvidence('result_uncertain')).toBe(true);
    expect(captureUncertainEvidence('action_required')).toBe(true);
  });
});
