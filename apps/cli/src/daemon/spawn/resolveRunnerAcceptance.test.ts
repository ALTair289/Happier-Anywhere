import { describe, expect, it } from 'vitest';

import { resolveExistingRunnerAcceptance } from './resolveRunnerAcceptance';

describe('resolveExistingRunnerAcceptance', () => {
  it('recognizes one exact persisted spawn nonce as the same accepted request', () => {
    expect(resolveExistingRunnerAcceptance({
      requestedSpawnNonce: ' handoff-attempt-1 ',
      trackedSpawnNonces: ['handoff-attempt-1'],
    })).toBe('same_request_runner');
  });

  it.each([
    { requestedSpawnNonce: undefined, trackedSpawnNonces: ['handoff-attempt-1'] },
    { requestedSpawnNonce: 'handoff-attempt-2', trackedSpawnNonces: ['handoff-attempt-1'] },
    { requestedSpawnNonce: 'handoff-attempt-1', trackedSpawnNonces: [] },
    { requestedSpawnNonce: 'handoff-attempt-1', trackedSpawnNonces: ['handoff-attempt-1', 'handoff-attempt-1'] },
  ])('fails closed for missing, mismatched, or ambiguous evidence: %j', (input) => {
    expect(resolveExistingRunnerAcceptance(input)).toBe('preexisting_or_adopted');
  });
});
