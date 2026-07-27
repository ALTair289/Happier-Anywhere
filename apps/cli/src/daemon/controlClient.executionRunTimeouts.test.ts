import { describe, expect, it } from 'vitest';

import { resolveExecutionRunConnectedServiceMaterializeTimeoutMs } from './controlClient';
import { ExecutionRunConnectedServiceMaterializeResponseSchema } from './connectedServices/runsBridge/contract';

const PROOF = {
  v: 1 as const,
  agentId: 'codex',
  materializationKey: 'execution_run:run-1',
  connectedServicesBindings: {
    v: 1 as const,
    bindingsByServiceId: {
      'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
    },
  },
};

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

describe('ExecutionRunConnectedServiceMaterializeResponseSchema', () => {
  it('rejects empty and whitespace-only materialization effects while retaining provider-owned env keys', () => {
    expect(ExecutionRunConnectedServiceMaterializeResponseSchema.safeParse({
      env: { CODEX_HOME: '' },
      proof: PROOF,
    }).success).toBe(false);
    expect(ExecutionRunConnectedServiceMaterializeResponseSchema.safeParse({
      env: { CODEX_HOME: '   ' },
      proof: PROOF,
    }).success).toBe(false);
    expect(ExecutionRunConnectedServiceMaterializeResponseSchema.safeParse({
      env: { PROVIDER_DEFINED_HOME: '', ANOTHER_PROVIDER_PATH: '/materialized/home' },
      proof: PROOF,
    }).success).toBe(true);
  });
});
