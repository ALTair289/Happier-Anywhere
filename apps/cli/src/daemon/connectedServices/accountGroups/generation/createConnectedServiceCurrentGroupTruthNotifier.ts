import {
  SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
  type ConnectedServiceId,
  type SessionConnectedServiceAuthCurrentGroupTruthV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';

type CurrentGroupTruthNotificationInput = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  applicationOwnerId: string;
  currentTruth: SessionConnectedServiceAuthCurrentGroupTruthV1;
  isCurrent?: () => boolean;
}>;

type CurrentGroupTruthNotificationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorCode: string }>;

export function createConnectedServiceCurrentGroupTruthNotifier<TTransport extends Readonly<{ sessionId: string }>>(
  deps: Readonly<{
    resolveTransport(sessionId: string): Promise<TTransport | null>;
    callRpc(input: Readonly<{
      transport: TTransport;
      method: string;
      request: unknown;
    }>): Promise<unknown>;
    applyRequestTimeBrokerCurrentTruth?: (
      input: CurrentGroupTruthNotificationInput,
    ) => Promise<CurrentGroupTruthNotificationResult | null>;
  }>,
): (input: CurrentGroupTruthNotificationInput) => Promise<CurrentGroupTruthNotificationResult> {
  return async (input) => {
    if (input.isCurrent?.() === false) {
      return { ok: false, errorCode: 'runtime_target_registration_superseded' };
    }
    const brokerResult = await deps.applyRequestTimeBrokerCurrentTruth?.(input) ?? null;
    if (brokerResult) return brokerResult;
    const descriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(
      input.applicationOwnerId as CatalogAgentId,
    );
    if (input.isCurrent?.() === false) {
      return { ok: false, errorCode: 'runtime_target_registration_superseded' };
    }
    const buildRequest = descriptor.buildLiveGenerationCurrentTruthRequest;
    if (!buildRequest) return { ok: true };

    const transport = await deps.resolveTransport(input.sessionId).catch(() => null);
    if (input.isCurrent?.() === false) {
      return { ok: false, errorCode: 'runtime_target_registration_superseded' };
    }
    if (!transport) {
      return { ok: false, errorCode: 'current_group_truth_session_transport_unavailable' };
    }
    const response = await deps.callRpc({
      transport,
      method: `${transport.sessionId}:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION}`,
      request: buildRequest({
        serviceId: input.serviceId,
        currentTruth: input.currentTruth,
      }),
    }).catch(() => null);
    const parsed = SessionConnectedServiceAuthApplyGenerationResponseV1Schema.safeParse(response);
    if (parsed.success && parsed.data.ok) return { ok: true };
    return {
      ok: false,
      errorCode: parsed.success && typeof parsed.data.errorCode === 'string'
        ? parsed.data.errorCode
        : parsed.success
          ? 'current_group_truth_notification_rejected'
          : 'current_group_truth_notification_failed',
    };
  };
}
