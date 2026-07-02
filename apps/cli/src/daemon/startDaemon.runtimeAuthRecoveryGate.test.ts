import { describe, expect, it } from 'vitest';

import { shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure } from './startDaemon';

describe('startDaemon runtime-auth recovery local storm gate', () => {
  it('does not treat provider rate limits as local server failures', () => {
    expect(shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure({
      retryable: true,
      kind: 'rate_limited',
    })).toBe(false);
  });

  it('keeps retryable timeout, network, and server errors in the local transport gate', () => {
    expect(shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure({
      retryable: true,
      kind: 'timeout',
    })).toBe(true);
    expect(shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure({
      retryable: true,
      kind: 'network',
    })).toBe(true);
    expect(shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure({
      retryable: true,
      kind: 'server_error',
    })).toBe(true);
  });
});
