import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import * as runtimeActivity from './index.js';

type Mutation = Readonly<{
  v: 2;
  sessionId: string;
  writerGeneration: string;
  mutationId: string;
  ownerScope: string;
  ownerSequence: number;
  operation: Readonly<Record<string, unknown>>;
}>;

type Projection = Readonly<{
  v: 2;
  state: 'active' | 'idle' | 'unknown';
  activeCount: number;
  sourceClass: string | null;
  observedAtMs: number | null;
  revision: number;
}>;

type Ack = Readonly<{
  status: string;
  ownerSequence: number;
  writerGeneration: string;
  projection: Projection;
}>;

type ReducerApi = Readonly<{
  createSessionRuntimeActivityReducerStateV2(input: Readonly<{
    sessionId: string;
    writerGeneration: string;
    expectedOwnerScopes: readonly string[];
    revision: number;
  }>): unknown;
  applySessionRuntimeActivityMutationV2(
    state: unknown,
    mutation: Mutation,
    options: Readonly<{ requestDigest: string; observedAtMs?: number }>,
  ): Readonly<{ state: unknown; ack: Ack }>;
  deriveSessionRuntimeActivityProjectionV2(state: unknown): Projection;
  compactSessionRuntimeActivityReducerStateV2(
    state: unknown,
    input: Readonly<{ ownerScope: string; throughSequence: number }>,
  ): unknown;
  decideRuntimeIdleAdmissionV2(projection: Projection): Readonly<{
    decision: 'allow' | 'defer';
    reason: string;
  }>;
  SessionRuntimeActivityMutationV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityReceiptCompactionV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityReceiptCompactionAckV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityProjectionV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityWriterClaimV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityWriterClaimAckV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityCredentialSchema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityRequestDigestSchema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityCapabilityIssueV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  SessionRuntimeActivityExpectedOwnerManifestV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  normalizeSessionRuntimeActivityExpectedOwnerManifestV2(value: readonly unknown[]): readonly string[];
  SessionRuntimeActivityCapabilityIssueAckV2Schema: {
    safeParse(value: unknown): Readonly<{ success: boolean }>;
  };
  readSessionRuntimeActivityMutationV2(value: unknown): unknown | null;
  readSessionRuntimeActivityProjectionCompatV2(value: unknown, nowMs: number): Projection;
  SESSION_RUNTIME_ACTIVITY_MUTATION_MAX_BYTES: number;
  SESSION_RUNTIME_ACTIVITY_ACTIVE_SOURCE_LIMIT: number;
  SESSION_RUNTIME_ACTIVITY_RECEIPT_RETENTION_LIMIT: number;
  SESSION_RUNTIME_ACTIVITY_SOCKET_EVENTS: Readonly<Record<string, string>>;
}>;

function canonical32(label: string): string {
  return createHash('sha256').update(label).digest('base64url');
}

function canonicalizeOperationIds(operation: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (operation.type === 'source-upsert' || operation.type === 'source-terminal') {
    return {
      ...operation,
      sourceKey: canonical32(String(operation.sourceKey)),
      occurrenceId: canonical32(String(operation.occurrenceId)),
    };
  }
  if (operation.type === 'owner-reconcile' && Array.isArray(operation.activeSources)) {
    return {
      ...operation,
      activeSources: operation.activeSources.map((source) => {
        const record = source as Readonly<Record<string, unknown>>;
        return {
          ...record,
          sourceKey: canonical32(String(record.sourceKey)),
          occurrenceId: canonical32(String(record.occurrenceId)),
        };
      }),
    };
  }
  return operation;
}

function api(): ReducerApi {
  return runtimeActivity as typeof runtimeActivity & ReducerApi;
}

function mutation(input: Omit<Mutation, 'v' | 'sessionId' | 'writerGeneration'> & Partial<Pick<Mutation, 'sessionId' | 'writerGeneration'>>): Mutation {
  return {
    v: 2,
    sessionId: input.sessionId ?? 'session-1',
    writerGeneration: input.writerGeneration ?? 'generation-1',
    mutationId: input.mutationId,
    ownerScope: input.ownerScope,
    ownerSequence: input.ownerSequence,
    operation: canonicalizeOperationIds(input.operation),
  };
}

function createState(ownerScopes: readonly string[] = ['claude.provider-task']): unknown {
  return api().createSessionRuntimeActivityReducerStateV2({
    sessionId: 'session-1',
    writerGeneration: 'generation-1',
    expectedOwnerScopes: ownerScopes,
    revision: 0,
  });
}

function apply(state: unknown, value: Mutation, requestDigest = `digest:${value.mutationId}`) {
  return api().applySessionRuntimeActivityMutationV2(state, value, {
    requestDigest: canonical32(requestDigest),
    observedAtMs: 1_000 + value.ownerSequence,
  });
}

describe('SessionRuntimeActivityV2 schemas', () => {
  it('accepts bounded provider-neutral mutations and rejects secret/public projection drift', () => {
    const valid = mutation({
      mutationId: 'mutation-1',
      ownerScope: 'claude.provider-task',
      ownerSequence: 1,
      operation: {
        type: 'source-upsert',
        sourceKey: 'opaque-source-1',
        occurrenceId: 'occurrence-1',
        sourceKind: 'provider_detached_task',
        lifecycleState: 'running',
      },
    });

    expect(api().SessionRuntimeActivityMutationV2Schema.safeParse(valid).success).toBe(true);
    expect(api().SessionRuntimeActivityMutationV2Schema.safeParse({
      ...valid,
      ownerScope: 'provider scope with spaces',
    }).success).toBe(false);
    expect(api().SessionRuntimeActivityProjectionV2Schema.safeParse({
      v: 2,
      state: 'idle',
      activeCount: 0,
      sourceClass: null,
      observedAtMs: null,
      revision: 0,
      writerCredential: 'must-never-be-public',
    }).success).toBe(false);
  });

  it('models receipt compaction as an explicit client acknowledgement with bounded monotonic coordinates', () => {
    const acknowledgement = {
      v: 2,
      sessionId: 'session-1',
      writerGeneration: 'generation-1',
      ownerScope: 'claude.provider-task',
      acknowledgedThroughSequence: 12,
    };

    expect(api().SessionRuntimeActivityReceiptCompactionV2Schema.safeParse(acknowledgement).success).toBe(true);
    expect(api().SessionRuntimeActivityReceiptCompactionV2Schema.safeParse({
      ...acknowledgement,
      acknowledgedThroughSequence: -1,
    }).success).toBe(false);
    expect(api().SessionRuntimeActivityReceiptCompactionV2Schema.safeParse({
      ...acknowledgement,
      writerCredential: canonical32('must-remain-socket-local'),
    }).success).toBe(false);

    expect(api().SessionRuntimeActivityReceiptCompactionAckV2Schema.safeParse({
      v: 2,
      status: 'compacted',
      writerGeneration: 'generation-1',
      ownerScope: 'claude.provider-task',
      ownerSequence: 12,
      lowWatermark: 12,
    }).success).toBe(true);
    expect(api().SessionRuntimeActivityReceiptCompactionAckV2Schema.safeParse({
      v: 2,
      status: 'receipt-gap',
      writerGeneration: 'generation-1',
      ownerScope: 'claude.provider-task',
      ownerSequence: 12,
      lowWatermark: 7,
    }).success).toBe(true);
  });

  it('keeps capability and writer credentials independent and validates mutation byte bounds', () => {
    const sharedSecret = 'A'.repeat(43);
    expect(api().SessionRuntimeActivityWriterClaimV2Schema.safeParse({
      v: 2,
      sessionId: 'session-1',
      machineId: 'machine-1',
      runnerLaunchId: 'launch-1',
      expectedCurrentGeneration: null,
      newGeneration: 'generation-1',
      claimMutationId: 'claim-1',
      capabilitySecret: sharedSecret,
      writerCredential: sharedSecret,
    }).success).toBe(false);
    expect(api().SessionRuntimeActivityWriterClaimV2Schema.safeParse({
      v: 2,
      sessionId: 'session-1',
      machineId: 'machine-1',
      runnerLaunchId: 'launch-1',
      expectedCurrentGeneration: null,
      newGeneration: 'generation-1',
      claimMutationId: 'claim-1',
      capabilitySecret: sharedSecret,
      writerCredential: `${'B'.repeat(42)}Q`,
    }).success).toBe(true);

    const oversized = mutation({
      mutationId: 'oversized', ownerScope: 'tasks', ownerSequence: 1,
      operation: {
        type: 'owner-unknown',
        reasonCode: `reason-${'x'.repeat(api().SESSION_RUNTIME_ACTIVITY_MUTATION_MAX_BYTES)}`,
      },
    });
    expect(api().readSessionRuntimeActivityMutationV2(oversized)).toBeNull();
    expect(new Set(Object.values(api().SESSION_RUNTIME_ACTIVITY_SOCKET_EVENTS)).size).toBe(5);
    expect(api().SessionRuntimeActivityCredentialSchema.safeParse('A'.repeat(43)).success).toBe(true);
    expect(api().SessionRuntimeActivityCredentialSchema.safeParse('A'.repeat(42)).success).toBe(false);
    expect(api().SessionRuntimeActivityCredentialSchema.safeParse(`${'A'.repeat(42)}=`).success).toBe(false);
    expect(api().SessionRuntimeActivityCredentialSchema.safeParse(`${'A'.repeat(42)}B`).success).toBe(false);
  });

  it('defines replay-safe claim and capability acknowledgements without echoing secrets', () => {
    expect(api().SessionRuntimeActivityCapabilityIssueAckV2Schema.safeParse({
      v: 2,
      issuanceId: 'issuance-1',
      status: 'issued',
      sessionId: 'session-1',
      expectedCurrentGeneration: null,
    }).success).toBe(true);
    expect(api().SessionRuntimeActivityWriterClaimAckV2Schema.safeParse({
      v: 2,
      claimMutationId: 'claim-1',
      status: 'claimed',
      writerGeneration: 'generation-1',
      projection: {
        v: 2, state: 'unknown', activeCount: 0, sourceClass: null,
        observedAtMs: null, revision: 1,
      },
      writerCredential: 'must-not-be-echoed',
    }).success).toBe(false);
  });

  it('canonicalizes expected owners as a sorted semantic set', () => {
    expect(api().normalizeSessionRuntimeActivityExpectedOwnerManifestV2([
      'workflow', 'tasks',
    ])).toEqual(['tasks', 'workflow']);
    expect(api().normalizeSessionRuntimeActivityExpectedOwnerManifestV2([
      'tasks', 'workflow',
    ])).toEqual(['tasks', 'workflow']);
    expect(api().normalizeSessionRuntimeActivityExpectedOwnerManifestV2([
      'a.owner', 'Z.owner',
    ])).toEqual(['Z.owner', 'a.owner']);
    expect(api().SessionRuntimeActivityExpectedOwnerManifestV2Schema.safeParse(['workflow', 'tasks']).success).toBe(false);
    expect(() => api().normalizeSessionRuntimeActivityExpectedOwnerManifestV2(['tasks', 'tasks'])).toThrow();
  });

  it('rejects duplicate source keys inside an authoritative snapshot at the schema boundary', () => {
    const duplicateSnapshot = mutation({
      mutationId: 'duplicate-snapshot', ownerScope: 'tasks', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'same', occurrenceId: 'first', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
        { sourceKey: 'same', occurrenceId: 'second', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
      ] },
    });
    expect(api().SessionRuntimeActivityMutationV2Schema.safeParse(duplicateSnapshot).success).toBe(false);
  });

  it('rejects internally contradictory public projections', () => {
    expect(api().SessionRuntimeActivityProjectionV2Schema.safeParse({
      v: 2, state: 'active', activeCount: 0, sourceClass: null,
      observedAtMs: null, revision: 1,
    }).success).toBe(false);
    expect(api().SessionRuntimeActivityProjectionV2Schema.safeParse({
      v: 2, state: 'idle', activeCount: 1, sourceClass: 'provider_detached_task',
      observedAtMs: 1, revision: 1,
    }).success).toBe(false);
  });

  it('rejects human-readable source identities and non-SHA-256 request digests', () => {
    const humanReadable: Mutation = {
      v: 2,
      sessionId: 'session-1',
      writerGeneration: 'generation-1',
      mutationId: 'raw-source', ownerScope: 'tasks', ownerSequence: 1,
      operation: {
        type: 'source-upsert', sourceKey: 'provider-task-123', occurrenceId: 'provider-run-456',
        sourceKind: 'provider_detached_task', lifecycleState: 'running',
      },
    };
    expect(api().SessionRuntimeActivityMutationV2Schema.safeParse(humanReadable).success).toBe(false);
    expect(api().SessionRuntimeActivityRequestDigestSchema.safeParse('digest:raw-source').success).toBe(false);
    expect(() => api().applySessionRuntimeActivityMutationV2(
      createState(),
      humanReadable,
      { requestDigest: 'digest:raw-source' },
    )).toThrow();
  });

  it('requires capability issuance to bind the verified supervisor epoch', () => {
    const request = {
      v: 2,
      sessionId: 'session-1',
      machineId: 'machine-1',
      runnerLaunchId: 'launch-1',
      issuanceId: 'issuance-1',
      expectedCurrentGeneration: null,
      expectedOwnerScopes: ['tasks'],
      capabilitySecret: 'A'.repeat(43),
    };
    expect(api().SessionRuntimeActivityCapabilityIssueV2Schema.safeParse(request).success).toBe(false);
    expect(api().SessionRuntimeActivityCapabilityIssueV2Schema.safeParse({
      ...request,
      supervisorEpoch: 1,
    }).success).toBe(true);
    expect(api().SessionRuntimeActivityCapabilityIssueV2Schema.safeParse({
      ...request,
      supervisorEpoch: 'supervisor-epoch-1',
    }).success).toBe(false);
  });
});

describe('session runtime activity reducer v2', () => {
  it('starts unknown and changes only from explicit lifecycle evidence, never elapsed time', () => {
    let state = createState();
    expect(api().deriveSessionRuntimeActivityProjectionV2(state)).toMatchObject({
      state: 'unknown',
      activeCount: 0,
      revision: 0,
    });

    ({ state } = apply(state, mutation({
      mutationId: 'snapshot-active',
      ownerScope: 'claude.provider-task',
      ownerSequence: 1,
      operation: {
        type: 'owner-reconcile',
        activeSources: [{
          sourceKey: 'source-a',
          occurrenceId: 'occurrence-a',
          sourceKind: 'provider_detached_task',
          lifecycleState: 'running',
        }],
      },
    })));

    const projection = api().deriveSessionRuntimeActivityProjectionV2(state);
    expect(projection).toMatchObject({ state: 'active', activeCount: 1 });
    expect(api().decideRuntimeIdleAdmissionV2(projection)).toEqual({ decision: 'defer', reason: 'active' });
    expect(api().deriveSessionRuntimeActivityProjectionV2(state)).toEqual(projection);
  });

  it('rejects an oversized or duplicate expected-owner manifest at generation creation', () => {
    expect(() => api().createSessionRuntimeActivityReducerStateV2({
      sessionId: 'session-1',
      writerGeneration: 'generation-1',
      expectedOwnerScopes: Array.from({ length: 17 }, (_, index) => `owner-${index}`),
      revision: 0,
    })).toThrow();
    expect(() => api().createSessionRuntimeActivityReducerStateV2({
      sessionId: 'session-1',
      writerGeneration: 'generation-1',
      expectedOwnerScopes: ['same', 'same'],
      revision: 0,
    })).toThrow();
  });

  it('advances the public revision only when aggregate meaning changes', () => {
    let state = createState();
    const start = apply(state, mutation({
      mutationId: 'start-meaning', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: {
        type: 'source-upsert', sourceKey: 'a', occurrenceId: 'a-1',
        sourceKind: 'provider_detached_task', lifecycleState: 'starting',
      },
    }));
    state = start.state;
    const progress = apply(state, mutation({
      mutationId: 'progress-no-meaning', ownerScope: 'claude.provider-task', ownerSequence: 2,
      operation: {
        type: 'source-upsert', sourceKey: 'a', occurrenceId: 'a-1',
        sourceKind: 'provider_detached_task', lifecycleState: 'running',
      },
    }));
    expect(progress.ack.projection.revision).toBe(start.ack.projection.revision);
    expect(progress.ack.projection.observedAtMs).toBe(start.ack.projection.observedAtMs);
  });

  it('continues a session-global revision supplied by writer replacement instead of resetting it', () => {
    let state = api().createSessionRuntimeActivityReducerStateV2({
      sessionId: 'session-1', writerGeneration: 'generation-2',
      expectedOwnerScopes: ['tasks'], revision: 41,
    });
    const result = apply(state, mutation({
      mutationId: 'replacement-reconcile', ownerScope: 'tasks', ownerSequence: 1,
      writerGeneration: 'generation-2',
      operation: { type: 'owner-reconcile', activeSources: [] },
    }));
    state = result.state;
    expect(api().deriveSessionRuntimeActivityProjectionV2(state).revision).toBe(42);
  });

  it('fails explicitly instead of emitting an unsafe integer when the public revision is exhausted', () => {
    const state = api().createSessionRuntimeActivityReducerStateV2({
      sessionId: 'session-1', writerGeneration: 'generation-1',
      expectedOwnerScopes: ['tasks'], revision: Number.MAX_SAFE_INTEGER,
    });
    expect(() => apply(state, mutation({
      mutationId: 'revision-exhausted', ownerScope: 'tasks', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [] },
    }))).toThrowError('Session runtime activity revision exhausted');
  });

  it('records not-applicable as an explicit expected-owner startup disposition', () => {
    const notApplicable = mutation({
      mutationId: 'tasks-not-applicable', ownerScope: 'tasks', ownerSequence: 1,
      operation: { type: 'owner-not-applicable', reasonCode: 'provider-capability-disabled' },
    });
    expect(api().SessionRuntimeActivityMutationV2Schema.safeParse(notApplicable).success).toBe(true);
    const result = apply(createState(['tasks']), notApplicable);
    expect(result.ack.status).toBe('applied');
    expect(result.ack.projection).toMatchObject({ state: 'idle', activeCount: 0 });
  });

  it('reconciles authoritative snapshots without allowing one owner to clear a sibling', () => {
    let state = createState(['claude.provider-task', 'claude.workflow']);
    ({ state } = apply(state, mutation({
      mutationId: 'tasks-ab', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'a', occurrenceId: 'a-1', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
        { sourceKey: 'b', occurrenceId: 'b-1', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
      ] },
    })));
    ({ state } = apply(state, mutation({
      mutationId: 'workflow', ownerScope: 'claude.workflow', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'workflow', occurrenceId: 'workflow-1', sourceKind: 'provider_autonomous_output', lifecycleState: 'waiting' },
      ] },
    })));
    ({ state } = apply(state, mutation({
      mutationId: 'tasks-b', ownerScope: 'claude.provider-task', ownerSequence: 2,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'b', occurrenceId: 'b-1', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
      ] },
    })));
    expect(api().deriveSessionRuntimeActivityProjectionV2(state)).toMatchObject({
      state: 'active', activeCount: 2, sourceClass: 'mixed',
    });

    ({ state } = apply(state, mutation({
      mutationId: 'tasks-empty', ownerScope: 'claude.provider-task', ownerSequence: 3,
      operation: { type: 'owner-reconcile', activeSources: [] },
    })));
    expect(api().deriveSessionRuntimeActivityProjectionV2(state)).toMatchObject({
      state: 'active', activeCount: 1, sourceClass: 'provider_autonomous_output',
    });
  });

  it('deduplicates exact mutation retries and rejects mutation-id digest conflicts', () => {
    const start = mutation({
      mutationId: 'same-id', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: {
        type: 'source-upsert', sourceKey: 'a', occurrenceId: 'a-1',
        sourceKind: 'provider_detached_task', lifecycleState: 'running',
      },
    });
    const first = apply(createState(), start, 'digest-a');
    const duplicate = apply(first.state, start, 'digest-a');
    const conflict = apply(first.state, start, 'digest-b');

    expect(first.ack.status).toBe('applied');
    expect(duplicate.ack).toEqual(first.ack);
    expect(conflict.ack.status).toBe('mutation-id-conflict');
    expect(conflict.state).toEqual(first.state);
  });

  it('rejects stale generations and sequence gaps without consuming owner order', () => {
    const staleGeneration = apply(createState(), mutation({
      mutationId: 'stale-generation', ownerScope: 'claude.provider-task', ownerSequence: 1,
      writerGeneration: 'generation-old',
      operation: { type: 'owner-reconcile', activeSources: [] },
    }));
    expect(staleGeneration.ack.status).toBe('stale-generation');

    const gap = apply(createState(), mutation({
      mutationId: 'gap', ownerScope: 'claude.provider-task', ownerSequence: 2,
      operation: { type: 'owner-reconcile', activeSources: [] },
    }));
    expect(gap.ack.status).toBe('sequence-gap');
    const contiguous = apply(gap.state, mutation({
      mutationId: 'contiguous', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [] },
    }));
    expect(contiguous.ack.status).toBe('applied');
    expect(api().decideRuntimeIdleAdmissionV2(contiguous.ack.projection)).toEqual({
      decision: 'allow', reason: 'explicit-idle',
    });
  });

  it('keeps terminal-before-start tombstones and consumes resurrection conflicts into unknown', () => {
    let state = createState();
    ({ state } = apply(state, mutation({
      mutationId: 'terminal-first', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: {
        type: 'source-terminal', sourceKey: 'a', occurrenceId: 'a-1', terminalState: 'completed',
      },
    })));
    const resurrection = apply(state, mutation({
      mutationId: 'late-start', ownerScope: 'claude.provider-task', ownerSequence: 2,
      operation: {
        type: 'source-upsert', sourceKey: 'a', occurrenceId: 'a-1',
        sourceKind: 'provider_detached_task', lifecycleState: 'running',
      },
    }));
    expect(resurrection.ack.status).toBe('reconciliation-required');
    expect(resurrection.ack.ownerSequence).toBe(2);
    expect(resurrection.ack.projection.state).toBe('unknown');

    const recovered = apply(resurrection.state, mutation({
      mutationId: 'new-occurrence', ownerScope: 'claude.provider-task', ownerSequence: 3,
      operation: {
        type: 'owner-reconcile', activeSources: [{
          sourceKey: 'a', occurrenceId: 'a-2', sourceKind: 'provider_detached_task', lifecycleState: 'running',
        }],
      },
    }));
    expect(recovered.ack.status).toBe('applied');
    expect(recovered.ack.projection).toMatchObject({ state: 'active', activeCount: 1 });
  });

  it('does not let a higher-sequence snapshot reactivate a terminal occurrence', () => {
    let state = createState();
    ({ state } = apply(state, mutation({
      mutationId: 'start', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: {
        type: 'source-upsert', sourceKey: 'a', occurrenceId: 'a-1',
        sourceKind: 'provider_detached_task', lifecycleState: 'running',
      },
    })));
    ({ state } = apply(state, mutation({
      mutationId: 'terminal', ownerScope: 'claude.provider-task', ownerSequence: 2,
      operation: {
        type: 'source-terminal', sourceKey: 'a', occurrenceId: 'a-1', terminalState: 'completed',
      },
    })));
    const lateSnapshot = apply(state, mutation({
      mutationId: 'late-snapshot', ownerScope: 'claude.provider-task', ownerSequence: 3,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'a', occurrenceId: 'a-1', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
      ] },
    }));
    expect(lateSnapshot.ack.status).toBe('reconciliation-required');
    expect(lateSnapshot.ack.projection).toMatchObject({ state: 'unknown', activeCount: 0 });
  });

  it('retains the prior occurrence tombstone when a source key is authoritatively reused', () => {
    let state = createState();
    ({ state } = apply(state, mutation({
      mutationId: 'first-occurrence', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'native-id', occurrenceId: 'occurrence-1', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
      ] },
    })));
    ({ state } = apply(state, mutation({
      mutationId: 'reused-key', ownerScope: 'claude.provider-task', ownerSequence: 2,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'native-id', occurrenceId: 'occurrence-2', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
      ] },
    })));
    const delayedOldOccurrence = apply(state, mutation({
      mutationId: 'delayed-old-occurrence', ownerScope: 'claude.provider-task', ownerSequence: 3,
      operation: {
        type: 'source-upsert', sourceKey: 'native-id', occurrenceId: 'occurrence-1',
        sourceKind: 'provider_detached_task', lifecycleState: 'running',
      },
    }));

    expect(delayedOldOccurrence.ack.status).toBe('reconciliation-required');
    expect(delayedOldOccurrence.ack.projection).toMatchObject({ state: 'unknown', activeCount: 0 });
  });

  it('does not let a late terminal for an old occurrence clear its replacement', () => {
    let state = createState();
    ({ state } = apply(state, mutation({
      mutationId: 'old', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'native-id', occurrenceId: 'old-1', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
      ] },
    })));
    ({ state } = apply(state, mutation({
      mutationId: 'new', ownerScope: 'claude.provider-task', ownerSequence: 2,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'native-id', occurrenceId: 'new-1', sourceKind: 'provider_detached_task', lifecycleState: 'waiting' },
      ] },
    })));
    const terminal = apply(state, mutation({
      mutationId: 'late-terminal', ownerScope: 'claude.provider-task', ownerSequence: 3,
      operation: {
        type: 'source-terminal', sourceKey: 'native-id', occurrenceId: 'old-1', terminalState: 'completed',
      },
    }));
    expect(terminal.ack.status).toBe('applied');
    expect(terminal.ack.projection).toMatchObject({ state: 'active', activeCount: 1 });
  });

  it('keeps explicit active evidence while a sibling owner is unknown', () => {
    let state = createState(['tasks', 'workflow']);
    ({ state } = apply(state, mutation({
      mutationId: 'tasks-active', ownerScope: 'tasks', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [
        { sourceKey: 'a', occurrenceId: 'a-1', sourceKind: 'provider_detached_task', lifecycleState: 'running' },
      ] },
    })));
    expect(api().deriveSessionRuntimeActivityProjectionV2(state)).toMatchObject({ state: 'active', activeCount: 1 });
    ({ state } = apply(state, mutation({
      mutationId: 'tasks-empty', ownerScope: 'tasks', ownerSequence: 2,
      operation: { type: 'owner-reconcile', activeSources: [] },
    })));
    expect(api().deriveSessionRuntimeActivityProjectionV2(state)).toMatchObject({ state: 'unknown', activeCount: 0 });
  });

  it('uses the owner low-watermark to compact receipts without admitting delayed stale events', () => {
    const original = mutation({
      mutationId: 'idle', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: { type: 'owner-reconcile', activeSources: [] },
    });
    const first = apply(createState(), original);
    const compacted = api().compactSessionRuntimeActivityReducerStateV2(first.state, {
      ownerScope: 'claude.provider-task', throughSequence: 1,
    });
    const delayed = apply(compacted, mutation({
      mutationId: 'delayed-new-id', ownerScope: 'claude.provider-task', ownerSequence: 1,
      operation: {
        type: 'source-upsert', sourceKey: 'a', occurrenceId: 'a-1',
        sourceKind: 'provider_detached_task', lifecycleState: 'running',
      },
    }));
    expect(delayed.ack.status).toBe('stale-sequence');
    expect(delayed.ack.projection.state).toBe('idle');
    const exactRetryAfterSafeCompaction = apply(compacted, original);
    expect(exactRetryAfterSafeCompaction.ack.status).toBe('stale-sequence');
    expect(exactRetryAfterSafeCompaction.ack.projection.state).toBe('idle');
  });

  it('fails closed to unknown instead of truncating when active-source bounds are exceeded', () => {
    let state = createState();
    for (let index = 1; index <= api().SESSION_RUNTIME_ACTIVITY_ACTIVE_SOURCE_LIMIT; index += 1) {
      ({ state } = apply(state, mutation({
        mutationId: `source-${index}`, ownerScope: 'claude.provider-task', ownerSequence: index,
        operation: {
          type: 'source-upsert', sourceKey: `source-${index}`, occurrenceId: `occurrence-${index}`,
          sourceKind: 'provider_detached_task', lifecycleState: 'running',
        },
      })));
    }
    const overflow = apply(state, mutation({
      mutationId: 'overflow', ownerScope: 'claude.provider-task',
      ownerSequence: api().SESSION_RUNTIME_ACTIVITY_ACTIVE_SOURCE_LIMIT + 1,
      operation: {
        type: 'source-upsert', sourceKey: 'overflow', occurrenceId: 'overflow-1',
        sourceKind: 'provider_detached_task', lifecycleState: 'running',
      },
    }));
    expect(overflow.ack.status).toBe('bounds-exceeded');
    expect(overflow.ack.projection).toMatchObject({ state: 'unknown', activeCount: 0 });
  });

  it('bounds receipt retention even when capacity failures repeat', () => {
    let state = createState();
    for (let sequence = 1; sequence <= 280; sequence += 1) {
      ({ state } = apply(state, mutation({
        mutationId: `receipt-${sequence}`,
        ownerScope: 'claude.provider-task',
        ownerSequence: sequence,
        operation: { type: 'owner-reconcile', activeSources: [] },
      })));
    }
    const retained = (state as Readonly<{ receipts: readonly unknown[] }>).receipts.length;
    expect(retained).toBeLessThanOrEqual(api().SESSION_RUNTIME_ACTIVITY_RECEIPT_RETENTION_LIMIT);
    expect(api().deriveSessionRuntimeActivityProjectionV2(state).state).toBe('unknown');
  });
});

describe('runtime activity v1 read compatibility', () => {
  it('maps an expired legacy active lease to unknown rather than idle', () => {
    expect(api().readSessionRuntimeActivityProjectionCompatV2({
      runtimeActivityVersion: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 50_000)).toMatchObject({ v: 2, state: 'unknown', activeCount: 0 });
  });

  it('maps explicit legacy zero and a valid legacy active lease without fabricating expiry for v2', () => {
    expect(api().readSessionRuntimeActivityProjectionCompatV2({
      runtimeActivityVersion: 1,
      runtimeActivityActiveCount: 0,
    }, 50_000)).toMatchObject({ state: 'idle', activeCount: 0 });
    expect(api().readSessionRuntimeActivityProjectionCompatV2({
      runtimeActivityVersion: 1,
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 10_000,
      runtimeActivityExpiresAt: 60_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 50_000)).toMatchObject({ state: 'active', activeCount: 2 });
  });

  it('maps malformed legacy active rows to unknown instead of trusting an incomplete aggregate', () => {
    expect(api().readSessionRuntimeActivityProjectionCompatV2({
      runtimeActivityVersion: 1,
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 10_000,
      runtimeActivityExpiresAt: 60_000,
      runtimeActivitySourceClass: null,
    }, 50_000)).toMatchObject({ state: 'unknown', activeCount: 0 });
  });

  it('maps explicit future or malformed versions to unknown without falling back to legacy idle', () => {
    expect(api().readSessionRuntimeActivityProjectionCompatV2({
      runtimeActivityVersion: 3,
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: 0,
      runtimeActivityRevision: 77,
    }, 50_000)).toMatchObject({ state: 'unknown', activeCount: 0, revision: 77 });
    expect(api().readSessionRuntimeActivityProjectionCompatV2({
      runtimeActivityVersion: 'malformed',
      runtimeActivityActiveCount: 0,
    }, 50_000)).toMatchObject({ state: 'unknown', activeCount: 0 });
  });
});
