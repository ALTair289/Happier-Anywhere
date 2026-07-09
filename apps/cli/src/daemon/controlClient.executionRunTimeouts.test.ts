import { describe, expect, it } from 'vitest';

import { resolveExecutionRunConnectedServiceMaterializeTimeoutMs } from './controlClient';

describe('resolveExecutionRunConnectedServiceMaterializeTimeoutMs (A1)', () => {
  it('defaults to a materialization-sized bound, NOT the generic 10s daemonPost default', () => {
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({})).toBe(120_000);
  });

  it('honors the env override within bounds', () => {
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '30000',
    })).toBe(30_000);
    // Clamped to sane bounds; garbage falls back to the default.
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '1',
    })).toBe(1_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '99999999',
    })).toBe(600_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: 'garbage',
    })).toBe(120_000);
  });
});
