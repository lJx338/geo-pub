export type EvidenceMode = 'minimal' | 'standard' | 'debug';

const EVIDENCE_MODE_ENV = 'GEO_EVIDENCE_MODE';

/**
 * Evidence is intentionally opt-in for successful operations. Failed and
 * uncertain operations are always captured by their callers.
 */
export function evidenceMode(environment: NodeJS.ProcessEnv = process.env): EvidenceMode {
  const configured = environment[EVIDENCE_MODE_ENV]?.trim().toLowerCase();
  if (configured === 'standard' || configured === 'debug') return configured;
  return 'minimal';
}

export function captureSuccessfulEvidence(environment: NodeJS.ProcessEnv = process.env): boolean {
  return evidenceMode(environment) !== 'minimal';
}

export function captureUncertainEvidence(status: string): boolean {
  return status !== 'success';
}
