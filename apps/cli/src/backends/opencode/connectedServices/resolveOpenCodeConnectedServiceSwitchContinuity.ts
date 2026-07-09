import { AGENTS_CORE } from '@happier-dev/agents';

import type {
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
} from '@/backends/types';
import { resolveConnectedServiceRestartContinuityAction } from '@/daemon/connectedServices/sessionAuthSwitch/continuity/resolveConnectedServiceSwitchAction';
import { openCodeConnectedServiceStateSharingDescriptor } from './openCodeConnectedServiceStateSharingDescriptor';

const OPENCODE_RESTART_REMATERIALIZE_REQUIRED_REASON = 'opencode_restart_rematerialize_required';

function supportsService(serviceId: string): boolean {
  return (AGENTS_CORE.opencode.connectedServices.supportedServiceIds as readonly string[]).includes(serviceId);
}

function hasBrokerSelectionIdentity(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).brokerSelectionIdentity === 'string'
    && ((value as Record<string, unknown>).brokerSelectionIdentity as string).trim().length > 0;
}

/**
 * OpenCode session state lives in the GLOBAL shared managed-server storage, NOT in the
 * selection-scoped materialized home, so every switch shape (changed selection, identical
 * re-selection, native->connected) resumes the same way: restart with rematerialized auth and
 * `--resume <ses_id>` against the global storage. There is no home-scoped exact-resume proof to
 * run here (RD-OPI-4): a probe over the materialized home can never see the global storage, and
 * failing closed on it would treat the SAFEST shape (identical re-selection) more strictly than a
 * changed selection.
 */
export async function resolveOpenCodeConnectedServiceSwitchContinuity(
  params: ConnectedServiceSwitchContinuityParams,
): Promise<ConnectedServiceSwitchContinuityResult> {
  if (!supportsService(params.serviceId)) {
    return { mode: 'unsupported', reason: 'unsupported_service' };
  }
  if (hasBrokerSelectionIdentity(params.runtimeAuthSelection)) {
    return { mode: 'hot_apply' };
  }
  return resolveConnectedServiceRestartContinuityAction({
    stateSharingDescriptor: openCodeConnectedServiceStateSharingDescriptor,
    restartReason: OPENCODE_RESTART_REMATERIALIZE_REQUIRED_REASON,
  });
}
