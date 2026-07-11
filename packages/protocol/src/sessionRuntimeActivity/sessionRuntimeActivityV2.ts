import { z } from 'zod';

import {
  SESSION_RUNTIME_ACTIVITY_MUTATION_MAX_BYTES,
  SESSION_RUNTIME_ACTIVITY_OWNER_LIMIT,
  SESSION_RUNTIME_ACTIVITY_SNAPSHOT_LIMIT,
  SessionRuntimeActivityCredentialSchema,
  SessionRuntimeActivityIssuanceIdSchema,
  SessionRuntimeActivityMutationIdSchema,
  SessionRuntimeActivityOccurrenceIdSchema,
  SessionRuntimeActivityOwnerScopeSchema,
  SessionRuntimeActivityReasonCodeSchema,
  SessionRuntimeActivityRevisionSchema,
  SessionRuntimeActivityRunnerLaunchIdSchema,
  SessionRuntimeActivitySequenceSchema,
  SessionRuntimeActivitySourceKeySchema,
  SessionRuntimeActivitySupervisorEpochSchema,
  SessionRuntimeActivityWriterGenerationSchema,
} from './sessionRuntimeActivityIdentity.js';
import { SessionRuntimeActivitySourceClassV1Schema } from './sessionRuntimeActivityV1.js';

function compareCanonicalAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export const SessionRuntimeActivityAggregateStateV2Schema = z.enum(['active', 'idle', 'unknown']);
export const SessionRuntimeActivityPublicVersionSchema = z.number().int().positive().safe();
export const SessionRuntimeActivitySourceKindV2Schema = z.enum([
  'provider_detached_task',
  'provider_autonomous_output',
  'execution_run',
]);
export const SessionRuntimeActivitySourceClassV2Schema = z.enum([
  'provider_detached_task',
  'provider_autonomous_output',
  'execution_run',
  'mixed',
]);
export const SessionRuntimeActivityActiveLifecycleStateV2Schema = z.enum(['starting', 'running', 'waiting']);
export const SessionRuntimeActivityTerminalLifecycleStateV2Schema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'killed',
  'interrupted',
]);
export const SessionRuntimeActivityLifecycleStateV2Schema = z.union([
  SessionRuntimeActivityActiveLifecycleStateV2Schema,
  SessionRuntimeActivityTerminalLifecycleStateV2Schema,
]);

export const SessionRuntimeActivityProjectionV2Schema = z.object({
  v: z.literal(2),
  state: SessionRuntimeActivityAggregateStateV2Schema,
  activeCount: z.number().int().nonnegative().safe(),
  sourceClass: SessionRuntimeActivitySourceClassV2Schema.nullable(),
  observedAtMs: z.number().int().nonnegative().safe().nullable(),
  revision: SessionRuntimeActivityRevisionSchema,
}).strict().superRefine((projection, context) => {
  const activeShapeValid = projection.activeCount > 0 && projection.sourceClass !== null;
  const inactiveShapeValid = projection.activeCount === 0 && projection.sourceClass === null;
  if ((projection.state === 'active' && !activeShapeValid)
    || (projection.state !== 'active' && !inactiveShapeValid)) {
    context.addIssue({ code: 'custom', message: 'Projection state, active count, and source class disagree' });
  }
});

export const SessionRuntimeActivityReconciledSourceV2Schema = z.object({
  sourceKey: SessionRuntimeActivitySourceKeySchema,
  occurrenceId: SessionRuntimeActivityOccurrenceIdSchema,
  sourceKind: SessionRuntimeActivitySourceKindV2Schema,
  lifecycleState: SessionRuntimeActivityActiveLifecycleStateV2Schema,
  nativeObservedAtMs: z.number().int().nonnegative().safe().optional(),
}).strict();

export const SessionRuntimeActivityOperationV2Schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('source-upsert'),
    sourceKey: SessionRuntimeActivitySourceKeySchema,
    occurrenceId: SessionRuntimeActivityOccurrenceIdSchema,
    sourceKind: SessionRuntimeActivitySourceKindV2Schema,
    lifecycleState: SessionRuntimeActivityActiveLifecycleStateV2Schema,
    nativeObservedAtMs: z.number().int().nonnegative().safe().optional(),
  }).strict(),
  z.object({
    type: z.literal('source-terminal'),
    sourceKey: SessionRuntimeActivitySourceKeySchema,
    occurrenceId: SessionRuntimeActivityOccurrenceIdSchema,
    terminalState: SessionRuntimeActivityTerminalLifecycleStateV2Schema,
    reasonCode: SessionRuntimeActivityReasonCodeSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('owner-reconcile'),
    activeSources: z.array(SessionRuntimeActivityReconciledSourceV2Schema).max(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_LIMIT),
  }).strict(),
  z.object({
    type: z.literal('owner-unknown'),
    reasonCode: SessionRuntimeActivityReasonCodeSchema,
  }).strict(),
  z.object({
    type: z.literal('owner-terminal'),
    reasonCode: SessionRuntimeActivityReasonCodeSchema,
  }).strict(),
  z.object({
    type: z.literal('owner-not-applicable'),
    reasonCode: SessionRuntimeActivityReasonCodeSchema,
  }).strict(),
]);

const SESSION_RUNTIME_ACTIVITY_PRIVATE_PUBLIC_FIELD_NAMES_V2 = new Set([
  'runtimeActivityWriterGeneration',
  'runtimeActivityWriterCredential',
  'runtimeActivityWriterCredentialHash',
  'runtimeActivityCapability',
  'runtimeActivityCapabilitySecret',
  'runtimeActivityExpectedOwnerScopes',
  'runtimeActivityOwners',
  'runtimeActivitySources',
  'runtimeActivityMutationReceipts',
  'runtimeActivitySupervisorEpoch',
  'runtimeActivityRunnerLaunchId',
]);

export function findPrivateSessionRuntimeActivityPublicFieldV2(
  value: Readonly<Record<string, unknown>>,
): string | null {
  for (const field of SESSION_RUNTIME_ACTIVITY_PRIVATE_PUBLIC_FIELD_NAMES_V2) {
    if (Object.prototype.hasOwnProperty.call(value, field)) return field;
  }
  return null;
}

export const SessionRuntimeActivityMutationV2Schema = z.object({
  v: z.literal(2),
  sessionId: z.string().trim().min(1).max(160),
  writerGeneration: SessionRuntimeActivityWriterGenerationSchema,
  mutationId: SessionRuntimeActivityMutationIdSchema,
  ownerScope: SessionRuntimeActivityOwnerScopeSchema,
  ownerSequence: SessionRuntimeActivitySequenceSchema,
  operation: SessionRuntimeActivityOperationV2Schema,
}).strict().superRefine((mutation, context) => {
  if (mutation.operation.type !== 'owner-reconcile') return;
  const sourceKeys = mutation.operation.activeSources.map((source) => source.sourceKey);
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    context.addIssue({
      code: 'custom',
      path: ['operation', 'activeSources'],
      message: 'Authoritative snapshot source keys must be unique',
    });
  }
});

export const SessionRuntimeActivityExpectedOwnerManifestV2Schema = z.array(SessionRuntimeActivityOwnerScopeSchema)
  .max(SESSION_RUNTIME_ACTIVITY_OWNER_LIMIT)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({ code: 'custom', message: 'Owner scopes must be unique' });
    }
    const sorted = [...scopes].sort(compareCanonicalAscii);
    if (scopes.some((scope, index) => scope !== sorted[index])) {
      context.addIssue({ code: 'custom', message: 'Owner scopes must use canonical sorted order' });
    }
  });

export function normalizeSessionRuntimeActivityExpectedOwnerManifestV2(
  scopes: readonly unknown[],
): SessionRuntimeActivityExpectedOwnerManifestV2 {
  const parsed = scopes.map((scope) => SessionRuntimeActivityOwnerScopeSchema.parse(scope));
  if (new Set(parsed).size !== parsed.length) throw new Error('Owner scopes must be unique');
  return SessionRuntimeActivityExpectedOwnerManifestV2Schema.parse(
    [...parsed].sort(compareCanonicalAscii),
  );
}

export const SessionRuntimeActivityCapabilityIssueV2Schema = z.object({
  v: z.literal(2),
  sessionId: z.string().trim().min(1).max(160),
  machineId: z.string().trim().min(1).max(160),
  supervisorEpoch: SessionRuntimeActivitySupervisorEpochSchema,
  runnerLaunchId: SessionRuntimeActivityRunnerLaunchIdSchema,
  issuanceId: SessionRuntimeActivityIssuanceIdSchema,
  expectedCurrentGeneration: SessionRuntimeActivityWriterGenerationSchema.nullable(),
  expectedOwnerScopes: SessionRuntimeActivityExpectedOwnerManifestV2Schema,
  capabilitySecret: SessionRuntimeActivityCredentialSchema,
}).strict();

export const SessionRuntimeActivityWriterClaimV2Schema = z.object({
  v: z.literal(2),
  sessionId: z.string().trim().min(1).max(160),
  machineId: z.string().trim().min(1).max(160),
  runnerLaunchId: SessionRuntimeActivityRunnerLaunchIdSchema,
  expectedCurrentGeneration: SessionRuntimeActivityWriterGenerationSchema.nullable(),
  newGeneration: SessionRuntimeActivityWriterGenerationSchema,
  claimMutationId: SessionRuntimeActivityMutationIdSchema,
  capabilitySecret: SessionRuntimeActivityCredentialSchema,
  writerCredential: SessionRuntimeActivityCredentialSchema,
}).strict().superRefine((claim, context) => {
  if (claim.capabilitySecret === claim.writerCredential) {
    context.addIssue({
      code: 'custom',
      path: ['writerCredential'],
      message: 'Writer credential must be independent from the successor capability',
    });
  }
});

export const SessionRuntimeActivityWriterAuthenticateV2Schema = z.object({
  v: z.literal(2),
  sessionId: z.string().trim().min(1).max(160),
  writerGeneration: SessionRuntimeActivityWriterGenerationSchema,
  writerCredential: SessionRuntimeActivityCredentialSchema,
}).strict();

export const SessionRuntimeActivityCapabilityIssueAckV2Schema = z.object({
  v: z.literal(2),
  issuanceId: SessionRuntimeActivityIssuanceIdSchema,
  status: z.enum(['issued', 'duplicate', 'stale-generation', 'conflict']),
  sessionId: z.string().trim().min(1).max(160),
  expectedCurrentGeneration: SessionRuntimeActivityWriterGenerationSchema.nullable(),
}).strict();

export const SessionRuntimeActivityWriterClaimAckV2Schema = z.object({
  v: z.literal(2),
  claimMutationId: SessionRuntimeActivityMutationIdSchema,
  status: z.enum([
    'claimed',
    'duplicate',
    'stale-generation',
    'capability-invalid',
    'capability-consumed',
    'conflict',
  ]),
  writerGeneration: SessionRuntimeActivityWriterGenerationSchema,
  projection: SessionRuntimeActivityProjectionV2Schema,
}).strict();

export const SessionRuntimeActivityWriterAuthenticateAckV2Schema = z.object({
  v: z.literal(2),
  status: z.enum(['authenticated', 'stale-generation', 'credential-invalid']),
  writerGeneration: SessionRuntimeActivityWriterGenerationSchema.nullable(),
  projection: SessionRuntimeActivityProjectionV2Schema.nullable(),
}).strict();

export const SessionRuntimeActivityMutationAckStatusV2Schema = z.enum([
  'applied',
  'duplicate',
  'stale-generation',
  'stale-sequence',
  'sequence-gap',
  'mutation-id-conflict',
  'reconciliation-required',
  'bounds-exceeded',
  'owner-not-expected',
]);

export const SessionRuntimeActivityMutationAckV2Schema = z.object({
  v: z.literal(2),
  mutationId: SessionRuntimeActivityMutationIdSchema,
  status: SessionRuntimeActivityMutationAckStatusV2Schema,
  writerGeneration: SessionRuntimeActivityWriterGenerationSchema,
  ownerSequence: SessionRuntimeActivitySequenceSchema,
  projection: SessionRuntimeActivityProjectionV2Schema,
}).strict();

// This is a client-to-server acknowledgement, not a lifecycle mutation. The
// writer sends it only after durably observing mutation acknowledgements
// through the named owner sequence. The server may then discard exact-replay
// receipts through that sequence while retaining the low-watermark and source
// occurrence tombstones that fence delayed lifecycle events.
export const SessionRuntimeActivityReceiptCompactionV2Schema = z.object({
  v: z.literal(2),
  sessionId: z.string().trim().min(1).max(160),
  writerGeneration: SessionRuntimeActivityWriterGenerationSchema,
  ownerScope: SessionRuntimeActivityOwnerScopeSchema,
  acknowledgedThroughSequence: SessionRuntimeActivitySequenceSchema,
}).strict();

export const SessionRuntimeActivityReceiptCompactionAckV2Schema = z.object({
  v: z.literal(2),
  status: z.enum([
    'compacted',
    'already-compacted',
    'stale-generation',
    'owner-not-expected',
    'acknowledgement-ahead',
    'receipt-gap',
  ]),
  writerGeneration: SessionRuntimeActivityWriterGenerationSchema,
  ownerScope: SessionRuntimeActivityOwnerScopeSchema,
  ownerSequence: SessionRuntimeActivitySequenceSchema,
  lowWatermark: SessionRuntimeActivitySequenceSchema,
}).strict();

export const SESSION_RUNTIME_ACTIVITY_SOCKET_EVENTS = Object.freeze({
  issueCapability: 'runtime-activity-issue-capability-v2',
  claimWriter: 'runtime-activity-claim-writer-v2',
  authenticateWriter: 'runtime-activity-authenticate-writer-v2',
  mutate: 'runtime-activity-mutate-v2',
  compactReceipts: 'runtime-activity-compact-receipts-v2',
} as const);

export type SessionRuntimeActivityAggregateStateV2 = z.infer<typeof SessionRuntimeActivityAggregateStateV2Schema>;
export type SessionRuntimeActivitySourceKindV2 = z.infer<typeof SessionRuntimeActivitySourceKindV2Schema>;
export type SessionRuntimeActivitySourceClassV2 = z.infer<typeof SessionRuntimeActivitySourceClassV2Schema>;
export type SessionRuntimeActivityActiveLifecycleStateV2 = z.infer<typeof SessionRuntimeActivityActiveLifecycleStateV2Schema>;
export type SessionRuntimeActivityTerminalLifecycleStateV2 = z.infer<typeof SessionRuntimeActivityTerminalLifecycleStateV2Schema>;
export type SessionRuntimeActivityLifecycleStateV2 = z.infer<typeof SessionRuntimeActivityLifecycleStateV2Schema>;
export type SessionRuntimeActivityProjectionV2 = z.infer<typeof SessionRuntimeActivityProjectionV2Schema>;
export type SessionRuntimeActivityReconciledSourceV2 = z.infer<typeof SessionRuntimeActivityReconciledSourceV2Schema>;
export type SessionRuntimeActivityOperationV2 = z.infer<typeof SessionRuntimeActivityOperationV2Schema>;
export type SessionRuntimeActivityMutationV2 = z.infer<typeof SessionRuntimeActivityMutationV2Schema>;
export type SessionRuntimeActivityExpectedOwnerManifestV2 = z.infer<typeof SessionRuntimeActivityExpectedOwnerManifestV2Schema>;
export type SessionRuntimeActivityCapabilityIssueV2 = z.infer<typeof SessionRuntimeActivityCapabilityIssueV2Schema>;
export type SessionRuntimeActivityWriterClaimV2 = z.infer<typeof SessionRuntimeActivityWriterClaimV2Schema>;
export type SessionRuntimeActivityWriterAuthenticateV2 = z.infer<typeof SessionRuntimeActivityWriterAuthenticateV2Schema>;
export type SessionRuntimeActivityCapabilityIssueAckV2 = z.infer<typeof SessionRuntimeActivityCapabilityIssueAckV2Schema>;
export type SessionRuntimeActivityWriterClaimAckV2 = z.infer<typeof SessionRuntimeActivityWriterClaimAckV2Schema>;
export type SessionRuntimeActivityWriterAuthenticateAckV2 = z.infer<typeof SessionRuntimeActivityWriterAuthenticateAckV2Schema>;
export type SessionRuntimeActivityMutationAckStatusV2 = z.infer<typeof SessionRuntimeActivityMutationAckStatusV2Schema>;
export type SessionRuntimeActivityMutationAckV2 = z.infer<typeof SessionRuntimeActivityMutationAckV2Schema>;
export type SessionRuntimeActivityReceiptCompactionV2 = z.infer<typeof SessionRuntimeActivityReceiptCompactionV2Schema>;
export type SessionRuntimeActivityReceiptCompactionAckV2 = z.infer<typeof SessionRuntimeActivityReceiptCompactionAckV2Schema>;

export type RuntimeIdleAdmissionDecisionV2 =
  | Readonly<{ decision: 'allow'; reason: 'explicit-idle' }>
  | Readonly<{ decision: 'defer'; reason: 'active' | 'unknown' | 'reconciling' }>;

export function decideRuntimeIdleAdmissionV2(
  projection: SessionRuntimeActivityProjectionV2,
): RuntimeIdleAdmissionDecisionV2 {
  if (projection.state === 'idle') return { decision: 'allow', reason: 'explicit-idle' };
  if (projection.state === 'active') return { decision: 'defer', reason: 'active' };
  return { decision: 'defer', reason: 'unknown' };
}

export function readSessionRuntimeActivityMutationV2(value: unknown): SessionRuntimeActivityMutationV2 | null {
  let encodedBytes: number;
  try {
    encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
  if (encodedBytes > SESSION_RUNTIME_ACTIVITY_MUTATION_MAX_BYTES) return null;
  const parsed = SessionRuntimeActivityMutationV2Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type SessionRuntimeActivityProjectionCompatibilityInput = Readonly<{
  runtimeActivityVersion?: unknown;
  runtimeActivityState?: unknown;
  runtimeActivityActiveCount?: unknown;
  runtimeActivityObservedAt?: unknown;
  runtimeActivityExpiresAt?: unknown;
  runtimeActivitySourceClass?: unknown;
  runtimeActivityRevision?: unknown;
}>;

function readSafeNonnegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint' && value >= BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return null;
}

export function readSessionRuntimeActivityProjectionCompatV2(
  input: SessionRuntimeActivityProjectionCompatibilityInput | null | undefined,
  nowMs: number,
): SessionRuntimeActivityProjectionV2 {
  if (input?.runtimeActivityVersion === 2) {
    const parsed = SessionRuntimeActivityProjectionV2Schema.safeParse({
      v: 2,
      state: input.runtimeActivityState,
      activeCount: input.runtimeActivityActiveCount,
      sourceClass: input.runtimeActivitySourceClass,
      observedAtMs: input.runtimeActivityObservedAt,
      revision: input.runtimeActivityRevision,
    });
    if (parsed.success) return parsed.data;
    return {
      v: 2,
      state: 'unknown',
      activeCount: 0,
      sourceClass: null,
      observedAtMs: null,
      revision: readSafeNonnegativeInteger(input.runtimeActivityRevision) ?? 0,
    };
  }

  if (input?.runtimeActivityVersion !== undefined && input.runtimeActivityVersion !== 1) {
    return {
      v: 2,
      state: 'unknown',
      activeCount: 0,
      sourceClass: null,
      observedAtMs: null,
      revision: readSafeNonnegativeInteger(input.runtimeActivityRevision) ?? 0,
    };
  }

  const activeCount = readSafeNonnegativeInteger(input?.runtimeActivityActiveCount);
  const observedAtMs = readSafeNonnegativeInteger(input?.runtimeActivityObservedAt);
  const expiresAtMs = readSafeNonnegativeInteger(input?.runtimeActivityExpiresAt);
  const validNow = readSafeNonnegativeInteger(nowMs);
  if (activeCount === 0) {
    return {
      v: 2, state: 'idle', activeCount: 0, sourceClass: null,
      observedAtMs, revision: 0,
    };
  }
  const sourceClass = SessionRuntimeActivitySourceClassV1Schema.safeParse(input?.runtimeActivitySourceClass);
  if (activeCount !== null
    && activeCount > 0
    && observedAtMs !== null
    && expiresAtMs !== null
    && expiresAtMs > observedAtMs
    && validNow !== null
    && expiresAtMs > validNow
    && sourceClass.success) {
    return {
      v: 2,
      state: 'active',
      activeCount,
      sourceClass: sourceClass.data,
      observedAtMs,
      revision: 0,
    };
  }
  return {
    v: 2, state: 'unknown', activeCount: 0, sourceClass: null,
    observedAtMs, revision: 0,
  };
}
