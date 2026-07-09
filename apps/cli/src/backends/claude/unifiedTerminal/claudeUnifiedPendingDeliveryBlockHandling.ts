import type { PendingDeliveryBlocker } from '@/agent/runtime/session/pendingDelivery/undeliverableProviderPrompt';

import type { ClaudeUnifiedDeliveryBlocker } from './_types';
import {
  isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive,
  promoteClaudeUnifiedProviderAcceptanceTimeoutBlockForUnavailableProvider,
  resolveClaudeUnifiedPendingDeliveryBlock,
  resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker,
  type ClaudeUnifiedProviderUnavailablePromptDeliveryWindow,
} from './pendingDeliveryBlock';
import { isClaudeUnifiedRuntimeControlUserDraftBlocker } from './runtimeControlIntegration';
import { isClaudeUnifiedTerminalAmbiguousInjectionFailureError } from './terminalInjectionFailureError';

export type ClaudeUnifiedTerminalRuntimeIssueHandlingResult =
  | boolean
  | void
  | Readonly<{ action: 'claimed_pending_delivery' }>
  | Readonly<{ action: 'surfaced_runtime_issue' }>;

export type PendingDeliveryRetryer = (params: Readonly<{ localId: string }>) => Promise<boolean>;

function canDurablyBlockSustainedClaudeUnifiedBlocker(params: Readonly<{
  blocker: ClaudeUnifiedDeliveryBlocker | null | undefined;
  isCanonicalTurnActive?: boolean | undefined;
}>): boolean {
  if (params.isCanonicalTurnActive !== false) return false;
  const blocker = params.blocker;
  if (!blocker) return false;
  if (blocker.kind === 'provider_unavailable') return true;
  if (blocker.kind === 'terminal_user_draft') {
    return (blocker as { guardStatus?: unknown }).guardStatus === 'foreign_draft';
  }
  if (blocker.kind === 'runtime_config_blocked') {
    const blockedReason = (blocker as { blockedReason?: unknown }).blockedReason;
    return isClaudeUnifiedRuntimeControlUserDraftBlocker(
      typeof blockedReason === 'string' ? blockedReason : undefined,
    );
  }
  return false;
}

export type ClaudeUnifiedSustainedPendingDeliveryBlockHandler = Readonly<{
  blockForSustainedBlocker(params: Readonly<{
    localIds: readonly string[] | null | undefined;
    blocker: ClaudeUnifiedDeliveryBlocker | null | undefined;
    isCanonicalTurnActive?: boolean | undefined;
  }>): Promise<boolean>;
  retryBlockedRowsOnce(): Promise<void>;
  dispose(): void;
}>;

export function createClaudeUnifiedSustainedPendingDeliveryBlockHandler(params: Readonly<{
  blockPendingMessageDelivery?: PendingDeliveryBlocker | undefined;
  retryPendingMessageDelivery?: PendingDeliveryRetryer | undefined;
  logPrefix: string;
  logDebug: (message: string, error: unknown) => void;
}>): ClaudeUnifiedSustainedPendingDeliveryBlockHandler {
  const blockedLocalIds = new Set<string>();
  let clearObservedWhileEmpty = false;
  let pendingBlockWrites = 0;

  const retryBlockedRows = async (): Promise<void> => {
    if (blockedLocalIds.size === 0) {
      if (pendingBlockWrites > 0) {
        clearObservedWhileEmpty = true;
      }
      return;
    }
    clearObservedWhileEmpty = false;
    const localIds = [...blockedLocalIds];
    blockedLocalIds.clear();
    if (!params.retryPendingMessageDelivery) return;
    await Promise.all(localIds.map((localId) =>
      params.retryPendingMessageDelivery?.({ localId }).catch((error) => {
        params.logDebug(`${params.logPrefix}: failed to retry Claude unified terminal pending delivery (non-fatal)`, error);
        return false;
      }),
    ));
  };

  return {
    async blockForSustainedBlocker(blockParams): Promise<boolean> {
      if (!canDurablyBlockSustainedClaudeUnifiedBlocker(blockParams)) return false;
      pendingBlockWrites += 1;
      const blocked = await blockClaudeUnifiedPendingDeliveryForBlocker({
          localIds: blockParams.localIds,
          blocker: blockParams.blocker,
          blockPendingMessageDelivery: params.blockPendingMessageDelivery,
          logPrefix: params.logPrefix,
          logDebug: params.logDebug,
        })
        .finally(() => {
          pendingBlockWrites = Math.max(0, pendingBlockWrites - 1);
        });
      if (!blocked) return false;
      const pendingDeliveryBlock = resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
        localIds: blockParams.localIds,
        blocker: blockParams.blocker,
      });
      for (const localId of pendingDeliveryBlock?.localIds ?? []) {
        blockedLocalIds.add(localId);
      }
      if (clearObservedWhileEmpty) {
        await retryBlockedRows();
      }
      return true;
    },
    async retryBlockedRowsOnce(): Promise<void> {
      await retryBlockedRows();
    },
    dispose(): void {
      blockedLocalIds.clear();
      clearObservedWhileEmpty = false;
      pendingBlockWrites = 0;
    },
  };
}

export async function blockClaudeUnifiedPendingDeliveryForBlocker(params: Readonly<{
  localIds: readonly string[] | null | undefined;
  blocker: ClaudeUnifiedDeliveryBlocker | null | undefined;
  blockPendingMessageDelivery?: PendingDeliveryBlocker | undefined;
  logPrefix: string;
  logDebug: (message: string, error: unknown) => void;
}>): Promise<boolean> {
  const pendingDeliveryBlock = resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
    localIds: params.localIds,
    blocker: params.blocker,
  });
  if (!pendingDeliveryBlock || !params.blockPendingMessageDelivery) return false;
  return params.blockPendingMessageDelivery(pendingDeliveryBlock).catch((error) => {
    params.logDebug(`${params.logPrefix}: failed to block Claude unified terminal pending delivery (non-fatal)`, error);
    return false;
  });
}

export async function handleClaudeUnifiedTerminalRuntimeIssuePendingDeliveryBlock(params: Readonly<{
  error: unknown;
  providerUnavailableWindow: ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null;
  setProviderUnavailableWindow: (window: ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null) => void;
  blockPendingMessageDelivery?: PendingDeliveryBlocker | undefined;
  nowMs?: (() => number) | undefined;
  logPrefix: string;
  logDebug: (message: string, error: unknown) => void;
  deferAmbiguousRuntimeIssue?: boolean | undefined;
  beforeSurfaceRuntimeIssue?: (() => void) | undefined;
  surfaceRuntimeIssue: (error: unknown) => Promise<boolean | null | undefined>;
  onSurfacedRuntimeIssue?: (() => void | Promise<void>) | undefined;
}>): Promise<ClaudeUnifiedTerminalRuntimeIssueHandlingResult> {
  const nowMs = params.nowMs?.() ?? Date.now();
  let providerUnavailableWindow = params.providerUnavailableWindow;
  if (!isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive(providerUnavailableWindow, nowMs)) {
    providerUnavailableWindow = null;
    params.setProviderUnavailableWindow(null);
  }

  const pendingDeliveryBlock = promoteClaudeUnifiedProviderAcceptanceTimeoutBlockForUnavailableProvider(
    resolveClaudeUnifiedPendingDeliveryBlock(params.error),
    providerUnavailableWindow,
    nowMs,
  );
  let didBlockPendingDelivery = false;
  if (pendingDeliveryBlock && params.blockPendingMessageDelivery) {
    didBlockPendingDelivery = await params.blockPendingMessageDelivery(pendingDeliveryBlock).catch((error) => {
      params.logDebug(`${params.logPrefix}: failed to block Claude unified terminal pending delivery (non-fatal)`, error);
      return false;
    });
    if (didBlockPendingDelivery && pendingDeliveryBlock.reason !== 'provider_acceptance_timeout') {
      return { action: 'claimed_pending_delivery' };
    }
  }

  if (params.deferAmbiguousRuntimeIssue === true && isClaudeUnifiedTerminalAmbiguousInjectionFailureError(params.error)) {
    return;
  }

  params.beforeSurfaceRuntimeIssue?.();
  const surfaced = await params.surfaceRuntimeIssue(params.error);
  if (surfaced) {
    await params.onSurfacedRuntimeIssue?.();
    if (!didBlockPendingDelivery) return { action: 'surfaced_runtime_issue' };
  }
  if (didBlockPendingDelivery) return { action: 'claimed_pending_delivery' };
  return surfaced ?? undefined;
}
