import { AGENTS_CORE } from '@happier-dev/agents';

import type {
  ConnectedServiceResumeContinuityDiagnostics,
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
} from '@/backends/types';
import {
  hasExactConnectedServiceRestartContinuityContext,
  isConnectedToConnectedServiceSwitch,
  isExactSameConnectedServiceSelection,
  isSameConnectedServiceAuthGroup,
  providerSessionStateUnavailableForResume,
} from '@/backends/connectedServices/switchContinuityContext';
import { canResumeFromMaterializedStateCore } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedStateCore';
import { resolveConnectedServiceRestartContinuityAction } from '@/daemon/connectedServices/sessionAuthSwitch/continuity/resolveConnectedServiceSwitchAction';
import { piConnectedServiceStateSharingDescriptor } from './piConnectedServiceStateSharingDescriptor';
import { verifyResumeReachablePi } from './verifyResumeReachablePi';

const PI_RESTART_REMATERIALIZE_REQUIRED_REASON = 'pi_restart_rematerialize_required';
const PI_EXACT_CONNECTED_SERVICE_SELECTION_REQUIRED_REASON = 'pi_exact_connected_service_selection_required';
const PI_SESSION_STATE_SHARING_REQUIRED_REASON = 'pi_session_state_sharing_required';

function supportsService(serviceId: string): boolean {
  return (AGENTS_CORE.pi.connectedServices.supportedServiceIds as readonly string[]).includes(serviceId);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Sanitized, secret-free summary of which required resume-continuity inputs were absent. Emits only
 * presence booleans (never the raw values: no home paths, vendor resume ids, env, or cwd) so a
 * fail-closed `provider_session_state_unavailable_for_resume` is debuggable without leaking secrets.
 */
function describeMissingPiResumeContinuityInputs(present: {
  materializationIdentity: boolean;
  targetMaterializedRoot: boolean;
  targetMaterializedEnv: boolean;
  vendorResumeId: boolean;
  cwd: boolean;
}): string {
  const missing: string[] = [];
  if (!present.materializationIdentity) missing.push('materialization_identity');
  if (!present.targetMaterializedRoot) missing.push('target_materialized_root');
  if (!present.targetMaterializedEnv) missing.push('target_materialized_env');
  if (!present.vendorResumeId) missing.push('vendor_resume_id');
  if (!present.cwd) missing.push('cwd');
  return missing.length > 0
    ? `pi_resume_continuity_missing:${missing.join(',')}`
    : 'pi_resume_continuity_inputs_present';
}

function piResumeContinuityMissingFieldDiagnostics(present: {
  materializationIdentity: boolean;
  targetMaterializedRoot: boolean;
  targetMaterializedEnv: boolean;
  vendorResumeId: boolean;
  cwd: boolean;
}): ConnectedServiceResumeContinuityDiagnostics {
  return {
    // Presence-only: never echo the raw materialized root, vendor resume id, env, or cwd values.
    materializationIdentityId: null,
    targetMaterializedRoot: null,
    vendorResumeId: null,
    cwd: null,
    candidatePersistedSessionFile: null,
    requestedStateMode: 'isolated',
    effectiveStateMode: 'isolated',
    reachabilityMissReason: describeMissingPiResumeContinuityInputs(present),
  };
}

export async function resolvePiConnectedServiceSwitchContinuity(
  params: ConnectedServiceSwitchContinuityParams,
): Promise<ConnectedServiceSwitchContinuityResult> {
  if (!supportsService(params.serviceId)) {
    return { mode: 'unsupported', reason: 'unsupported_service' };
  }
  if (isSameConnectedServiceAuthGroup(params) || isExactSameConnectedServiceSelection(params)) {
    const targetMaterializedRoot = asNonEmptyString(params.targetMaterializedRoot);
    const vendorResumeId = asNonEmptyString(params.vendorResumeId);
    const cwd = asNonEmptyString(params.cwd);
    const materializationIdentity = params.connectedServiceMaterializationIdentityV1 ?? null;
    const targetMaterializedEnv = params.targetMaterializedEnv ?? null;
    const presentResumeInputs = {
      materializationIdentity: Boolean(materializationIdentity),
      targetMaterializedRoot: Boolean(targetMaterializedRoot),
      targetMaterializedEnv: Boolean(targetMaterializedEnv),
      vendorResumeId: Boolean(vendorResumeId),
      cwd: Boolean(cwd),
    };

    if (!hasExactConnectedServiceRestartContinuityContext(params)) {
      return providerSessionStateUnavailableForResume({
        diagnostics: piResumeContinuityMissingFieldDiagnostics(presentResumeInputs),
      });
    }

    if (
      !targetMaterializedRoot
      || !vendorResumeId
      || !cwd
      || !materializationIdentity
      || !targetMaterializedEnv
    ) {
      return providerSessionStateUnavailableForResume({
        diagnostics: piResumeContinuityMissingFieldDiagnostics(presentResumeInputs),
      });
    }

    const reachability = await canResumeFromMaterializedStateCore({
      targetMaterializedRoot,
      targetMaterializedEnv,
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      materializationIdentity,
      vendorResumeId,
      cwd,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      verifyResumeReachable: verifyResumeReachablePi,
    });
    return reachability.ok
      ? { mode: 'restart_same_home' }
      : providerSessionStateUnavailableForResume({
          diagnostics: reachability.continuityDiagnostics,
        });
  }
  if (isConnectedToConnectedServiceSwitch(params)) {
    return resolveConnectedServiceRestartContinuityAction({
      stateSharingDescriptor: piConnectedServiceStateSharingDescriptor,
      restartReason: PI_RESTART_REMATERIALIZE_REQUIRED_REASON,
      sharedStateRequiredReason: PI_EXACT_CONNECTED_SERVICE_SELECTION_REQUIRED_REASON,
    });
  }
  return resolveConnectedServiceRestartContinuityAction({
    stateSharingDescriptor: piConnectedServiceStateSharingDescriptor,
    restartReason: PI_RESTART_REMATERIALIZE_REQUIRED_REASON,
    sharedStateRequiredReason: PI_SESSION_STATE_SHARING_REQUIRED_REASON,
  });
}
