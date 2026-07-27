// Provider-outcome proof gate for runtime-auth recovery success.
//
// Local recovery substeps (a switch event, an auth-store adoption, a credential
// refresh, a process restart request) are NOT proof that the recovered provider
// can actually authenticate. Treating them as terminal recovery success is the
// root cause behind the live Codex/Pi/Claude recovery loops: recovery was cleared
// while the provider session was still broken.
//
// Switch application results are progress, not provider recovery. A later
// provider-qualified outcome may recover the intent; a genuinely fresh candidate
// remains useful intermediate evidence only.
//
// A bare `credential_refreshed`, a generic `ok: true`, or an `observed_generation`
// with no verification and no candidate change is INTERMEDIATE: the local step
// completed, but no provider-outcome proof exists yet. We must not clear the
// recovery as recovered in that case; the existing scheduler lifecycle keeps it
// pending/waiting (and ultimately moves it toward action-required/exhausted),
// instead of fabricating a stuck "succeeded" state.
//
// WAVE-3 SEAM: bounded provider-activity proof (assistant delta / tool call /
// accepted in-flight steer after the recovery boundary, with a timeout -> terminal)
// is the second proof class. It is modeled in the shared
// `recovery/providerOutcomeProof.ts` contract as `provider_activity` but is
// intentionally NOT produced here so we do not create "wait forever" states;
// until it lands, refresh-without-deterministic-proof simply stays pending under
// the scheduler's normal backoff/exhaustion lifecycle.
//
// This resolver MAPS the runtime-auth switch result onto the shared, provider-agnostic
// `ProviderOutcomeProofKind` contract. The mapping is thin and behavior-preserving:
// the deterministic evidence it can establish is `fresh_candidate_selected`.
// Fresh-candidate selection intentionally stays intermediate until later provider
// activity/native resume/quota proof arrives. All other local completions
// (credential_refreshed, generic ok:true, unverified switch/observed_generation)
// map to `null` (no proof).

import {
  type ProviderOutcomeProofKind,
  isRecoveredProviderOutcomeProof,
} from '../recovery/providerOutcomeProof';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Unwrap the `{ status: 'switch_attempted', result }` envelope to the inner
 * connected-service auth-group switch result, mirroring the runtime-auth
 * recovery callback contract.
 */
export function readRuntimeAuthRecoverySwitchResult(
  result: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(result)) return null;
  if (result.status === 'switch_attempted' && isRecord(result.result)) return result.result;
  return result;
}

function hasFreshCandidateSelected(switchResult: Readonly<Record<string, unknown>>): boolean {
  const activeProfileId = readString(switchResult.activeProfileId);
  if (!activeProfileId) return false;
  // `fromProfileId` is only present when the switch actually moved off a known
  // failed profile. When it is absent we cannot prove freshness deterministically.
  const fromProfileId = readString(switchResult.fromProfileId);
  if (!fromProfileId) return false;
  return fromProfileId !== activeProfileId;
}

// Runtime-auth recovery can derive accepted post-switch verification and fresh-candidate
// evidence from switch results. Provider/runtime owners may also pass through an explicit
// `proofKind` from the shared provider-outcome contract when they own stronger
// evidence such as native resume, quota probe, provider activity, or terminal proof.
// Quota proof is settled by the quota owner with its failure-class/fingerprint
// scope. `native_resume` has no producer. Application verification carried by a
// switch result is deliberately not promoted here.
export type RuntimeAuthRecoveryProofKind = ProviderOutcomeProofKind;

/**
 * Resolve whether a runtime-auth recovery result carries provider-outcome proof,
 * mapped onto the shared `ProviderOutcomeProofKind` contract. Returns the proof
 * kind when proven, otherwise `null`.
 */
export function resolveRuntimeAuthRecoveryProof(result: unknown): RuntimeAuthRecoveryProofKind | null {
  const switchResult = readRuntimeAuthRecoverySwitchResult(result);
  if (!switchResult) return null;
  if (switchResult.proofKind === 'provider_activity') return 'provider_activity';
  if (
    switchResult.proofKind === 'terminal_action_required'
    || switchResult.proofKind === 'terminal_exhausted'
  ) return switchResult.proofKind;
  if (hasFreshCandidateSelected(switchResult)) return 'fresh_candidate_selected';
  return null;
}

/**
 * True only when the runtime-auth recovery result proves the provider outcome
 * deterministically (a recovered proof class). Local-only completions
 * (credential_refreshed, generic ok:true, unverified switch/observed_generation)
 * are intentionally NOT success.
 */
export function isProvenRuntimeAuthRecoverySuccess(result: unknown): boolean {
  return isRecoveredProviderOutcomeProof(resolveRuntimeAuthRecoveryProof(result));
}
