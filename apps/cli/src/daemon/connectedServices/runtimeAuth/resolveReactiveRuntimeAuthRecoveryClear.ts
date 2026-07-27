// Shared proof gate for the REACTIVE daemon runtime-auth recovery-success paths.
//
// The daemon-run reactive recovery flow has three success-clear entrypoints:
//   - `onCommittedSwitch`: fires the instant the server active-profile CAS commits
//     (a LOCAL/metadata-only event — NOT provider-outcome proof);
//   - `emitEvent` on `switched`/`observed_generation`: a switch event row;
//   - the `onRuntimeAuthRecoverySuccess` observer: fires on group-switch
//     `switched`/`observed_generation` and on bare `credential_refreshed`.
//
// Before this gate, all three cleared the recovery intent (`markSucceededByKey`)
// with NO provider-outcome proof. That is the exact live loop the plan exists to
// kill: a metadata-only switch / observed_generation / credential refresh treated
// as recovered while the provider session is still broken.
//
// This module routes every reactive entrypoint through the SAME shared,
// provider-agnostic proof contract (`recovery/providerOutcomeProof.ts` via
// `resolveRuntimeAuthRecoveryProof`). A reactive source clears recovery ONLY when
// it carries provider-qualified recovered outcome proof. Local application
// verification and a genuinely fresh candidate remain useful
// intermediate evidence but does NOT clear recovery by itself. Otherwise the
// recovery stays pending
// (provider-outcome-waiting) under the scheduler's backoff/exhaustion lifecycle.
//
// Each entrypoint maps its own signal onto a switch-result-shaped object (the shape
// `resolveRuntimeAuthRecoveryProof` consumes) so the gate stays single-sourced and
// the entrypoints cannot drift apart.

import { isRecoveredProviderOutcomeProof } from '../recovery/providerOutcomeProof';
import { resolveRuntimeAuthRecoveryProof } from './resolveRuntimeAuthRecoveryOutcome';
import type { RuntimeAuthRecoveryProofKind } from './resolveRuntimeAuthRecoveryOutcome';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../accountTransitions/acceptedConnectedServiceAccountVerification';

export type ReactiveRuntimeAuthRecoverySource = 'committed_switch' | 'event' | 'observer';

/**
 * The minimal proof-bearing signal each reactive entrypoint can supply. All fields
 * are optional because each source carries a different subset; the gate proves
 * success only when one of the accepted proof classes can be established from what
 * is present.
 */
export type ReactiveRuntimeAuthRecoverySignal = Readonly<{
  /** The profile the switch moved OFF of, when known (fresh-candidate evidence). */
  fromProfileId?: string | null;
  /** The profile the switch landed ON. */
  activeProfileId?: string | null;
  /** Post-switch application verification, which is progress rather than provider outcome proof. */
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId | null;
}>;

export type ReactiveRuntimeAuthRecoveryClearDecision =
  | Readonly<{ clear: true; proof: RuntimeAuthRecoveryProofKind }>
  | Readonly<{ clear: false; proof: RuntimeAuthRecoveryProofKind | null }>;

/**
 * Decide whether a reactive runtime-auth recovery source may clear the recovery
 * intent. Returns `{ clear: true, proof }` only when the signal carries accepted
 * provider-outcome proof; otherwise `{ clear: false }` (the recovery stays
 * provider-outcome-waiting under the scheduler lifecycle).
 */
export function resolveReactiveRuntimeAuthRecoveryClear(
  signal: ReactiveRuntimeAuthRecoverySignal,
): ReactiveRuntimeAuthRecoveryClearDecision {
  const proof = resolveRuntimeAuthRecoveryProof({
    ...(signal.fromProfileId === undefined || signal.fromProfileId === null
      ? {}
      : { fromProfileId: signal.fromProfileId }),
    ...(signal.activeProfileId === undefined || signal.activeProfileId === null
      ? {}
      : { activeProfileId: signal.activeProfileId }),
    ...(signal.verificationByServiceId === undefined || signal.verificationByServiceId === null
      ? {}
      : { verificationByServiceId: signal.verificationByServiceId }),
  });
  if (proof === null) return { clear: false, proof: null };
  if (!isRecoveredProviderOutcomeProof(proof)) {
    return { clear: false, proof };
  }
  return { clear: true, proof };
}
