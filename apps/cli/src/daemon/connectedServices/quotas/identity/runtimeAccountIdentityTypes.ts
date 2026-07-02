import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

export type RuntimeAccountIdentityProofStrength = 'exact' | 'weak';

export type RuntimeAccountIdentityStrategy =
  | 'provider_account_id'
  | 'shared_group_auth_surface';

export type RuntimeAccountIdentitySource =
  | 'runtime_quota_snapshot'
  | 'active_account_verification'
  | 'spawn_selection'
  | 'group_switch_selection'
  | 'codex_live_auth_apply'
  | 'runtime_auth_failure_report'
  | 'runtime_identity_probe';

export type RuntimeAccountIdentityRecordInput = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  providerAccountId: string;
  accountLabel: string | null;
  observedAtMs: number;
  source: RuntimeAccountIdentitySource;
  proofStrength: RuntimeAccountIdentityProofStrength;
  groupGeneration: number | null;
}>;

export type RuntimeAccountIdentitySelectionInput = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId?: string | null;
  groupGeneration?: number | null;
  record: ConnectedServiceCredentialRecordV1;
  source: Extract<
    RuntimeAccountIdentitySource,
    'spawn_selection' | 'group_switch_selection' | 'codex_live_auth_apply'
  >;
}>;

export type RuntimeAccountIdentityProbeResult =
  | Readonly<{
      status: 'verified';
      strategy?: RuntimeAccountIdentityStrategy;
      providerAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      accountLabel?: string | null;
      proofStrength?: 'exact' | 'weak';
      source?: RuntimeAccountIdentitySource;
      profileId?: string | null;
      groupId?: string | null;
      groupGeneration?: number | null;
      runtime?: Readonly<{
        safeToApply?: boolean;
        inProviderTurn?: boolean;
      }>;
    }>
  | Readonly<{
      status: 'inexact' | 'unavailable';
      reason?: string;
      accountLabel?: string | null;
      runtime?: Readonly<{
        safeToApply?: boolean;
        inProviderTurn?: boolean;
      }>;
    }>;

export type RuntimeAccountIdentityEntry = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  providerAccountId: string;
  accountLabel: string | null;
  observedAtMs: number;
  source: RuntimeAccountIdentitySource;
  proofStrength: 'exact';
  groupGeneration: number | null;
}>;

export type ReconciledRuntimeAccountIdentityEntry = RuntimeAccountIdentityEntry & Readonly<{
  runtime?: Readonly<{
    safeToApply?: boolean;
    inProviderTurn?: boolean;
  }>;
}>;

export type RuntimeAccountIdentityRecordResult =
  | Readonly<{ status: 'recorded' }>
  | Readonly<{
      status: 'suppressed';
      reason:
        | 'exact_provider_account_proof_required'
        | 'missing_session_id'
        | 'missing_profile_id'
        | 'missing_provider_account_id'
        | 'missing_group_generation'
        | 'invalid_observed_at';
    }>;
