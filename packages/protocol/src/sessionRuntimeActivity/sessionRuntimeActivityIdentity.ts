import { z } from 'zod';

import { MachineSupervisorEpochSchema } from '../machineOwnership/supervisorAuthority.js';

export const SESSION_RUNTIME_ACTIVITY_OWNER_LIMIT = 16;
export const SESSION_RUNTIME_ACTIVITY_ACTIVE_SOURCE_LIMIT = 32;
export const SESSION_RUNTIME_ACTIVITY_TERMINAL_OCCURRENCE_LIMIT = 128;
export const SESSION_RUNTIME_ACTIVITY_RECEIPT_LIMIT = 256;
export const SESSION_RUNTIME_ACTIVITY_RECEIPT_RETENTION_LIMIT =
  SESSION_RUNTIME_ACTIVITY_RECEIPT_LIMIT + SESSION_RUNTIME_ACTIVITY_OWNER_LIMIT;
export const SESSION_RUNTIME_ACTIVITY_SNAPSHOT_LIMIT = 32;
export const SESSION_RUNTIME_ACTIVITY_MUTATION_MAX_BYTES = 64 * 1024;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// A 32-byte value encodes to 43 unpadded base64url characters. The final
// character carries four payload bits and therefore has two canonical zero pad bits.
const CANONICAL_BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function boundedOpaqueId(max: number) {
  return z.string().trim().min(1).max(max).regex(OPAQUE_ID_PATTERN);
}

export const SessionRuntimeActivityOwnerScopeSchema = boundedOpaqueId(96);
export const SessionRuntimeActivitySourceKeySchema = z.string().regex(CANONICAL_BASE64URL_32_BYTES_PATTERN);
export const SessionRuntimeActivityOccurrenceIdSchema = z.string().regex(CANONICAL_BASE64URL_32_BYTES_PATTERN);
export const SessionRuntimeActivityWriterGenerationSchema = boundedOpaqueId(128);
export const SessionRuntimeActivityMutationIdSchema = boundedOpaqueId(128);
export const SessionRuntimeActivityRequestDigestSchema = z.string().regex(CANONICAL_BASE64URL_32_BYTES_PATTERN);
export const SessionRuntimeActivityReasonCodeSchema = boundedOpaqueId(96);
export const SessionRuntimeActivityRunnerLaunchIdSchema = boundedOpaqueId(128);
export const SessionRuntimeActivityIssuanceIdSchema = boundedOpaqueId(128);
export const SessionRuntimeActivitySupervisorEpochSchema = MachineSupervisorEpochSchema.refine(
  (value) => value > 0,
  { message: 'Runtime-activity capability issuance requires a current supervisor epoch' },
);
export const SessionRuntimeActivityCredentialSchema = z.string().regex(CANONICAL_BASE64URL_32_BYTES_PATTERN);
export const SessionRuntimeActivityLaunchChallengeSchema = SessionRuntimeActivityCredentialSchema;
export const SessionRuntimeActivitySequenceSchema = z.number().int().nonnegative().safe();
export const SessionRuntimeActivityRevisionSchema = z.number().int().nonnegative().safe();

export type SessionRuntimeActivityOwnerScope = z.infer<typeof SessionRuntimeActivityOwnerScopeSchema>;
export type SessionRuntimeActivitySourceKey = z.infer<typeof SessionRuntimeActivitySourceKeySchema>;
export type SessionRuntimeActivityOccurrenceId = z.infer<typeof SessionRuntimeActivityOccurrenceIdSchema>;
export type SessionRuntimeActivityWriterGeneration = z.infer<typeof SessionRuntimeActivityWriterGenerationSchema>;
export type SessionRuntimeActivityMutationId = z.infer<typeof SessionRuntimeActivityMutationIdSchema>;
export type SessionRuntimeActivityRequestDigest = z.infer<typeof SessionRuntimeActivityRequestDigestSchema>;
