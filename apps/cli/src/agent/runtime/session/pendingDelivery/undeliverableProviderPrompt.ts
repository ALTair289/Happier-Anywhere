import type { PendingQueueDeliveryBlockedReason } from '@/api/session/pendingQueueV2Transport';
import { logger } from '@/ui/logger';

export type PendingDeliveryBlocker = (params: Readonly<{
  localIds: readonly string[] | null | undefined;
  reason: PendingQueueDeliveryBlockedReason;
}>) => Promise<boolean>;

export function normalizePendingDeliveryLocalIds(
  localIds: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of localIds ?? []) {
    const localId = typeof value === 'string' ? value.trim() : '';
    if (!localId || seen.has(localId)) continue;
    seen.add(localId);
    normalized.push(localId);
  }
  return normalized;
}

export function returnOrBlockUndeliverableProviderPrompt<LegacyInput>(params: Readonly<{
  input: LegacyInput;
  localIds: readonly string[] | null | undefined;
  blockPendingMessageDelivery?: PendingDeliveryBlocker | undefined;
  blockReason: PendingQueueDeliveryBlockedReason;
  onBlocked?: (input: LegacyInput) => void;
  requeueLegacyInput: (input: LegacyInput) => void;
  logPrefix: string;
}>): void {
  const localIds = normalizePendingDeliveryLocalIds(params.localIds);
  if (localIds.length === 0 || !params.blockPendingMessageDelivery) {
    params.requeueLegacyInput(params.input);
    return;
  }

  void params.blockPendingMessageDelivery({ localIds, reason: params.blockReason })
    .then((claimedByPendingDelivery) => {
      if (claimedByPendingDelivery) {
        params.onBlocked?.(params.input);
        return;
      }
      if (!claimedByPendingDelivery) {
        params.requeueLegacyInput(params.input);
      }
    })
    .catch((error) => {
      logger.debug(`${params.logPrefix}: failed to block undeliverable provider pending delivery; falling back to legacy requeue`, error);
      params.requeueLegacyInput(params.input);
    });
}
