import type { PendingDeliveryDetailV1 } from '@happier-dev/protocol';
import type { TranslationKey } from '@/text';

export function resolveClaudePendingDeliveryLabelKey(input: Readonly<{
    localId: string | null;
    detail: PendingDeliveryDetailV1 | undefined;
    custodyObservedLocalId: unknown;
}>): TranslationKey | null {
    if (input.detail === 'custody_observed') {
        return 'session.pendingMessages.deliveryStatus.queuedInClaude';
    }
    if (
        typeof input.localId === 'string'
        && input.localId.length > 0
        && typeof input.custodyObservedLocalId === 'string'
        && input.custodyObservedLocalId.length > 0
        && input.localId === input.custodyObservedLocalId
    ) {
        return 'session.pendingMessages.deliveryStatus.queuedInClaude';
    }
    return null;
}
