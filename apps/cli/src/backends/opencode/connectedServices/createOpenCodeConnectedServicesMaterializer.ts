import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { materializeOpenCodeConnectedServiceAuth } from './materializeOpenCodeConnectedServiceAuth';
import type { OpenCodeConnectedServiceId } from './openCodeConnectedServicePrecedence';
import { OPEN_CODE_CONNECTED_SERVICE_PRECEDENCE } from './openCodeConnectedServicePrecedence';

export function createOpenCodeConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const readRecord = (serviceId: OpenCodeConnectedServiceId) =>
      params.selectionsByServiceId?.get(serviceId)?.record ?? params.recordsByServiceId.get(serviceId) ?? null;
    const openaiCodex = readRecord('openai-codex');
    const openai = readRecord('openai');
    const claudeSubscription = readRecord('claude-subscription');
    const anthropic = readRecord('anthropic');
    const primary = OPEN_CODE_CONNECTED_SERVICE_PRECEDENCE
      .map((serviceId) => readRecord(serviceId))
      .find((record) => record != null) ?? null;
    if (!primary) return null;

    const materialized = await materializeOpenCodeConnectedServiceAuth({
      rootDir: params.rootDir,
      openaiCodex,
      openai,
      claudeSubscription,
      anthropic,
      ...(params.selectionsByServiceId ? { selectionsByServiceId: params.selectionsByServiceId } : {}),
    });
    return { env: materialized.env, cleanupOnFailure: params.cleanupRoot, cleanupOnExit: null };
  };
}
