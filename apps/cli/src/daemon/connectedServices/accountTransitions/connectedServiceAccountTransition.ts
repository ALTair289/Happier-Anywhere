import type {
  ConnectedServiceBindingsV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';

// Production account transitions are owned by sessionAuthSwitch/switchSessionConnectedServiceAuth.ts.
// This module only carries the shared transition verification types.
export type ConnectedServiceAccountTransitionTrigger =
  | 'manual'
  | 'reactive_runtime_auth'
  | 'proactive_pre_turn'
  | 'provider_account_changed'
  | 'refresh_reconnect';

export type ConnectedServiceAccountTransitionAction =
  | 'hot_applied'
  | 'restart_requested'
  | 'metadata_updated';

export type ConnectedServiceAccountTransitionTarget = Readonly<{
  serviceId: string;
  profileId: string | null;
  providerAccountId?: string | null;
  groupId?: string | null;
  generation?: number | null;
}>;

export type ConnectedServiceAccountTransitionVerificationResult =
  | Readonly<{
      status: 'verified';
      providerAccountId?: string | null;
      activeAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
      credentialFingerprint?: string | null;
      generationApplication?: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileId: string;
        generation: number;
        credentialRevision: ConnectedServiceCredentialRevisionV1;
        credentialFingerprint: string;
      }>;
      proofStrength?: 'exact' | 'weak' | 'diagnostic';
      source?: string;
      reason?: string;
    }>
  | Readonly<{
      status: 'weakly_verified';
      providerAccountId?: string | null;
      activeAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
      credentialFingerprint?: string | null;
      proofStrength?: 'exact' | 'weak' | 'diagnostic';
      source?: string;
      reason: string;
    }>
  | Readonly<{
      status: 'mismatch';
      expectedProviderAccountId?: string | null;
      actualProviderAccountId?: string | null;
      retryable: boolean;
      reason?: string;
    }>
  | Readonly<{
      status: 'unavailable';
      retryable: boolean;
      reason: string;
      errorClassification?: unknown;
    }>;

export type ConnectedServiceAccountAdoptionVerificationInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  target: ConnectedServiceAccountTransitionTarget;
  normalizedBindings: ConnectedServiceBindingsV1;
  action: Extract<ConnectedServiceAccountTransitionAction, 'hot_applied' | 'restart_requested'>;
  runtimeAuthSelection?: unknown;
}>;

export type ConnectedServiceAccountTransitionFailureCode =
  | 'account_transition_failed'
  | 'provider_account_adoption_mismatch'
  | 'post_switch_verification_failed';

export type ConnectedServiceAccountTransitionResult =
  | Readonly<{
      ok: true;
      action: ConnectedServiceAccountTransitionAction;
      verification: Extract<ConnectedServiceAccountTransitionVerificationResult, { status: 'verified' | 'weakly_verified' }>;
    }>
  | Readonly<{
      ok: false;
      errorCode: ConnectedServiceAccountTransitionFailureCode;
      retryable: boolean;
      diagnostics: Readonly<{
        failurePhase: 'persist_binding' | 'materialize_home' | 'reachability' | 'apply' | 'post_switch_verification';
        verification?: Readonly<{
          expectedProviderAccountId?: string | null;
          actualProviderAccountId?: string | null;
          reason?: string;
          errorClassification?: unknown;
        }>;
      }>;
    }>;
