import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import {
  findConnectedServiceBindingSelectionFromSessionMetadata,
  findConnectedServiceChildSelection,
  type ConnectedServiceRuntimeAuthMetadataSession,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  createConnectedServiceQuotaSnapshotDeliveryOutbox,
  type ConnectedServiceQuotaSnapshotDeliveryDiagnostic,
  type ConnectedServiceQuotaSnapshotDeliveryFlushReason,
  type ConnectedServiceQuotaSnapshotDeliveryFlushResult,
  type ConnectedServiceQuotaSnapshotDeliveryOutbox,
} from '@/daemon/connectedServices/quotas/connectedServiceQuotaSnapshotDeliveryOutbox';
import { buildNativeProviderAccountUsageSourceProfileId } from '@/daemon/connectedServices/accountUsage/nativeSourceIdentity';
import { deliverConnectedServiceQuotaSnapshotToDaemon } from '@/daemon/connectedServices/quotas/deliverConnectedServiceQuotaSnapshotToDaemon';
import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';
import { mapCodexRateLimitSnapshotToQuotaSnapshot } from './mapCodexRateLimitSnapshot';
import {
  readCodexAuthStoreProviderAccountId,
  type CodexAuthStoreProviderAccountIdProof,
} from './readCodexAuthStoreProviderAccountId';

type NotifyQuotaSnapshot = (body: Readonly<{
  sessionId: string;
  serviceId: 'openai-codex';
  groupId?: string | null;
  groupGeneration?: number | null;
  sourceProviderAccountId?: string | null;
  snapshot: ConnectedServiceQuotaSnapshotV1;
}>) => Promise<unknown>;

export type CodexQuotaSnapshotDeliveryFailureDiagnostic = ConnectedServiceQuotaSnapshotDeliveryDiagnostic;
export type CodexQuotaSnapshotReportResult = ConnectedServiceQuotaSnapshotDeliveryFlushResult;
export const CODEX_QUOTA_SNAPSHOT_DELIVERY_RETRY_DELAY_MS = 1_000;

export function createCodexQuotaSnapshotDeliveryOutboxForNotify(input: Readonly<{
  /**
   * Optional explicit notify seam (used by `reportCodexRateLimitSnapshotToDaemon` callers + tests).
   * When omitted, delivery routes through the ONE shared full-payload daemon deliver helper
   * (CS-FIX-3) so `sourceProviderAccountId` can never be dropped by a hand-rolled per-site closure.
   */
  notify?: NotifyQuotaSnapshot;
  onDiagnostic?: (diagnostic: ConnectedServiceQuotaSnapshotDeliveryDiagnostic) => void;
  retryDelayMs?: number | null;
}>): ConnectedServiceQuotaSnapshotDeliveryOutbox {
  const notify = input.notify;
  return createConnectedServiceQuotaSnapshotDeliveryOutbox({
    deliver: notify
      ? async ({ sessionId, groupId, groupGeneration, sourceProviderAccountId, snapshot }) => await notify({
          sessionId,
          serviceId: 'openai-codex',
          ...(groupId !== undefined ? { groupId } : {}),
          ...(groupGeneration !== undefined ? { groupGeneration } : {}),
          ...(sourceProviderAccountId !== undefined ? { sourceProviderAccountId } : {}),
          snapshot,
        })
      : deliverConnectedServiceQuotaSnapshotToDaemon,
    retryDelayMs: input.retryDelayMs === undefined
      ? CODEX_QUOTA_SNAPSHOT_DELIVERY_RETRY_DELAY_MS
      : input.retryDelayMs,
    onDiagnostic: input.onDiagnostic,
  });
}

const defaultCodexQuotaSnapshotDeliveryOutbox = createCodexQuotaSnapshotDeliveryOutboxForNotify({});

export async function flushPendingCodexQuotaSnapshotsToDaemon(input: Readonly<{
  deliveryOutbox?: ConnectedServiceQuotaSnapshotDeliveryOutbox;
  reason: Extract<ConnectedServiceQuotaSnapshotDeliveryFlushReason, 'daemon_reconnect' | 'session_report'>;
  sessionId?: string;
}>): Promise<ConnectedServiceQuotaSnapshotDeliveryFlushResult> {
  return await (input.deliveryOutbox ?? defaultCodexQuotaSnapshotDeliveryOutbox).flushPending({
    reason: input.reason,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
}

async function resolveCodexNativeQuotaIdentity(env: Pick<NodeJS.ProcessEnv, string>): Promise<Readonly<{
  profileId: string;
  activeAccountId: string | null;
  accountLabel: string | null;
}>> {
  const codexHome = resolveConfiguredCodexHome(env);
  let proof: CodexAuthStoreProviderAccountIdProof;
  try {
    proof = await readCodexAuthStoreProviderAccountId(codexHome);
  } catch {
    proof = { status: 'missing' };
  }
  if (proof.status === 'resolved') {
    return {
      profileId: buildNativeProviderAccountUsageSourceProfileId({
        kind: 'providerSubject',
        providerId: 'codex',
        material: proof.accountId,
      }),
      activeAccountId: proof.accountId,
      accountLabel: proof.accountEmail ?? null,
    };
  }
  return {
    profileId: buildNativeProviderAccountUsageSourceProfileId({
      kind: 'localCredential',
      providerId: 'codex',
      material: codexHome,
    }),
    activeAccountId: null,
    accountLabel: null,
  };
}

// Snapshot attribution must follow the CURRENT member identity. After a hot-apply
// group switch the child env still names the pre-switch activeProfileId while the
// materialized auth store and the live app-server already belong to the new member;
// attributing post-switch healthy meters to the exhausted member would falsely
// clear its limiter (F7) and corrupt group selection. Same metadata-first→env
// order as `resolveOpenAiCodexDaemonRefreshSelection` and the classification context.
function resolveSelectedCodexProfileId(input: Readonly<{
  env: Pick<NodeJS.ProcessEnv, string>;
  session?: ConnectedServiceRuntimeAuthMetadataSession | null;
}>): Readonly<{ profileId: string; groupId: string | null; groupGeneration: number | null }> | null {
  const childSelection = findConnectedServiceChildSelection(input.env, 'openai-codex');
  if (input.session) {
    const binding = findConnectedServiceBindingSelectionFromSessionMetadata(input.session, 'openai-codex');
    if (binding?.source === 'connected') {
      if (binding.selection === 'group') {
        if (binding.profileId) {
          return {
            profileId: binding.profileId,
            groupId: binding.groupId,
            groupGeneration: childSelection?.kind === 'group' && childSelection.groupId === binding.groupId
              ? childSelection.generation
              : null,
          };
        }
      } else {
        return {
          profileId: binding.profileId,
          groupId: null,
          groupGeneration: null,
        };
      }
    }
  }
  if (!childSelection) return null;
  return childSelection.kind === 'group'
    ? {
        profileId: childSelection.activeProfileId,
        groupId: childSelection.groupId,
        groupGeneration: childSelection.generation,
      }
    : {
        profileId: childSelection.profileId,
        groupId: null,
        groupGeneration: null,
      };
}

export async function reportCodexRateLimitSnapshotToDaemon(input: Readonly<{
  env: Pick<NodeJS.ProcessEnv, string>;
  session?: ConnectedServiceRuntimeAuthMetadataSession | null;
  sessionId: string;
  rawSnapshot: unknown;
  // Live provider-account proof supplied by Codex app-server `account/read`.
  // Do not substitute auth-store identity for connected-service sessions.
  activeAccountId?: string | null;
  accountLabel?: string | null;
  sourceProviderAccountId?: string | null;
  rawResetCredits?: unknown;
  nowMs?: number;
  notify?: NotifyQuotaSnapshot;
  onDeliveryFailure?: (diagnostic: CodexQuotaSnapshotDeliveryFailureDiagnostic) => void;
  onDeliveryDiagnostic?: (diagnostic: CodexQuotaSnapshotDeliveryFailureDiagnostic) => void;
  deliveryOutbox?: ConnectedServiceQuotaSnapshotDeliveryOutbox;
}>): Promise<CodexQuotaSnapshotReportResult> {
  const selectedContext = resolveSelectedCodexProfileId(input);
  const nativeIdentity = await resolveCodexNativeQuotaIdentity(input.env);
  const identity = selectedContext
    ? {
        profileId: selectedContext.profileId,
        groupId: selectedContext.groupId,
        groupGeneration: selectedContext.groupGeneration,
        activeAccountId: input.activeAccountId ?? null,
        accountLabel: input.accountLabel ?? null,
      }
    : {
        ...nativeIdentity,
        groupId: null,
        groupGeneration: null,
      };

  const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
    serviceId: 'openai-codex',
    profileId: identity.profileId,
    activeAccountId: identity.activeAccountId,
    accountLabel: identity.accountLabel,
    fetchedAt: input.nowMs ?? Date.now(),
    rawSnapshot: input.rawSnapshot,
    rawResetCredits: input.rawResetCredits,
  });
  const onDiagnostic = input.onDeliveryDiagnostic ?? input.onDeliveryFailure;
  const deliveryOutbox = input.deliveryOutbox
    ?? (input.notify
      ? createCodexQuotaSnapshotDeliveryOutboxForNotify({
          notify: input.notify,
          onDiagnostic,
        })
      : defaultCodexQuotaSnapshotDeliveryOutbox);
  return await deliveryOutbox.enqueueAndFlush({
    sessionId: input.sessionId,
    serviceId: 'openai-codex',
    groupId: identity.groupId,
    groupGeneration: identity.groupGeneration,
    ...(input.sourceProviderAccountId !== undefined ? { sourceProviderAccountId: input.sourceProviderAccountId } : {}),
    snapshot,
  });
}
