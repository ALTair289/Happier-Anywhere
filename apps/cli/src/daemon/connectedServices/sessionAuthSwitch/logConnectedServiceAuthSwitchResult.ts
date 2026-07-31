import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { SessionConnectedServiceAuthSwitchResult } from './switchSessionConnectedServiceAuth';

export function logConnectedServiceAuthSwitchResult(input: Readonly<{
  logger: Pick<typeof console, 'debug'>;
  sessionId: string;
  agentId: string;
  serviceIds: readonly string[];
  result: SessionConnectedServiceAuthSwitchResult;
  startedAtMs: number;
  finishedAtMs: number;
  previousBindings: ConnectedServiceBindingsV1;
  expectedGroupGenerationByServiceId: Readonly<Record<string, number>> | undefined;
}>): void {
  input.logger.debug('[DAEMON RUN] Connected-service session auth switch result', {
    sessionId: input.sessionId,
    agentId: input.agentId,
    serviceIds: input.serviceIds,
    ok: input.result.ok,
    latencyMs: Math.max(0, Math.trunc(input.finishedAtMs - input.startedAtMs)),
    previousBindings: input.previousBindings,
    expectedGroupGenerationByServiceId: input.expectedGroupGenerationByServiceId,
    ...(input.result.ok
      ? {
          action: input.result.action,
          continuityByServiceId: input.result.continuityByServiceId,
          ...(input.result.verificationByServiceId
            ? { verificationByServiceId: input.result.verificationByServiceId }
            : {}),
        }
      : {
          errorCode: input.result.errorCode,
          serviceId: input.result.serviceId,
          diagnostics: input.result.diagnostics,
        }),
  });
}
