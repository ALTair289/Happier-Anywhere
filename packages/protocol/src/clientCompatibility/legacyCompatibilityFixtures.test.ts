import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const LegacyKeepForeverRetentionPolicySchema = z.strictObject({
  mode: z.literal('keep_forever'),
});

const LegacyAgeBasedRetentionPolicySchema = z.discriminatedUnion('mode', [
  LegacyKeepForeverRetentionPolicySchema,
  z.strictObject({
    mode: z.literal('delete_older_than'),
    days: z.number().int().min(1),
  }),
]);

const LegacySessionRetentionPolicySchema = z.discriminatedUnion('mode', [
  LegacyKeepForeverRetentionPolicySchema,
  z.strictObject({
    mode: z.literal('delete_inactive'),
    inactivityDays: z.number().int().min(1),
    requires: z.tuple([z.literal('updatedAt'), z.literal('lastActiveAt')]),
  }),
]);

const LegacyServerRetentionCapabilitiesSchema = z.strictObject({
  policyVersion: z.literal(1),
  enabled: z.boolean(),
  sessions: LegacySessionRetentionPolicySchema,
  sessionMessages: LegacyAgeBasedRetentionPolicySchema.optional(),
  accountChanges: LegacyAgeBasedRetentionPolicySchema,
  voiceSessionLeases: LegacyAgeBasedRetentionPolicySchema,
  userFeedItems: LegacyAgeBasedRetentionPolicySchema,
  sessionShareAccessLogs: LegacyAgeBasedRetentionPolicySchema,
  publicShareAccessLogs: LegacyAgeBasedRetentionPolicySchema,
  terminalAuthRequests: LegacyAgeBasedRetentionPolicySchema,
  accountAuthRequests: LegacyAgeBasedRetentionPolicySchema,
  authPairingSessions: LegacyAgeBasedRetentionPolicySchema,
  repeatKeys: LegacyAgeBasedRetentionPolicySchema,
  globalLocks: LegacyAgeBasedRetentionPolicySchema,
  automationRuns: LegacyAgeBasedRetentionPolicySchema,
  automationRunEvents: LegacyAgeBasedRetentionPolicySchema,
});

const LegacyOptionalNonEmptyStringSchema = z.string().trim().min(1).optional();
const LegacyServerCapabilitiesSchema = z
  .object({
    canonicalServerUrl: LegacyOptionalNonEmptyStringSchema,
    webappUrl: LegacyOptionalNonEmptyStringSchema,
    retention: LegacyServerRetentionCapabilitiesSchema.optional(),
  })
  .strict();

// Snapshot the deployed pre-compatibility outer shape. Importing the live
// FeaturesResponseSchema would stop being an old-client fixture once the new
// sibling becomes part of the current schema.
const LegacyFeaturesResponseSchema = z.object({
  features: z.object({}),
  capabilities: z.object({
    server: LegacyServerCapabilitiesSchema.optional(),
  }),
});

const LegacyUpdateSessionV1Schema = z
  .object({
    t: z.literal('update-session'),
    id: z.string(),
    runtimeActivityActiveCount: z.number().int().nonnegative().optional(),
    runtimeActivityObservedAt: z.number().int().nonnegative().nullable().optional(),
    runtimeActivityExpiresAt: z.number().int().nonnegative().nullable().optional(),
    runtimeActivitySourceClass: z.enum(['provider_detached_task', 'provider_autonomous_output', 'execution_run', 'mixed']).nullable().optional(),
  })
  .passthrough();

describe('deployed legacy compatibility fixtures', () => {
  it('an old features parser accepts and strips the new compatibility sibling capability', () => {
    const parsed = LegacyFeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        compatibility: {
          v: 1,
          sessionSync: {
            v: 1,
            enforcement: 'required',
            minimumSessionSyncProtocolVersion: 2,
            declarationTransport: 'headers-v1',
          },
        },
      },
    });

    expect(parsed.capabilities).not.toHaveProperty('compatibility');

    expect(LegacyFeaturesResponseSchema.safeParse({
      features: {},
      capabilities: {
        server: {
          compatibility: {
            sessionSync: { minimumSessionSyncProtocolVersion: 2 },
          },
        },
      },
    }).success).toBe(false);
  });

  it('an old passthrough session-update parser silently accepts v2 fields and null expiry', () => {
    const parsed = LegacyUpdateSessionV1Schema.parse({
      t: 'update-session',
      id: 'session-1',
      runtimeActivityVersion: 2,
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 100,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: 'provider_detached_task',
      runtimeActivityRevision: 7,
    });

    expect(parsed.runtimeActivityVersion).toBe(2);
    expect(parsed.runtimeActivityState).toBe('active');
    expect(parsed.runtimeActivityRevision).toBe(7);
    expect(parsed.runtimeActivityExpiresAt).toBeNull();

    const legacyExpiryDerivedIdle = parsed.runtimeActivityActiveCount <= 0
      || parsed.runtimeActivityExpiresAt === null;
    expect(legacyExpiryDerivedIdle).toBe(true);
  });
});
