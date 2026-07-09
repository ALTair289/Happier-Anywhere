import { notifyDaemonConnectedServiceQuotaSnapshot } from '@/daemon/controlClient';

import type { ConnectedServiceQuotaSnapshotDeliveryInput } from './connectedServiceQuotaSnapshotDeliveryOutbox';

/**
 * CS-FIX-3: the ONE quota-snapshot deliver closure. Every provider's delivery outbox
 * (claude in-band, codex in-band, codex runCodex-local) routes its `deliver` through here so the
 * full payload — including `sourceProviderAccountId`, the source-of-truth provider-account
 * attribution proof — is always forwarded to the daemon door. Hand-rolling the closure per provider
 * is exactly what let the runCodex-local copy silently drop `sourceProviderAccountId`; this removes
 * that whole drift surface.
 */
export async function deliverConnectedServiceQuotaSnapshotToDaemon(
  body: ConnectedServiceQuotaSnapshotDeliveryInput,
): Promise<unknown> {
  return await notifyDaemonConnectedServiceQuotaSnapshot(body);
}
