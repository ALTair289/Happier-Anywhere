import type {
  SessionProviderInputOutcomeObserver,
  SessionProviderInputOutcomeProducer,
  SessionProviderInputRejectedBeforeEffectReason,
} from '@/api/session/sessionClient';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { readPendingLocalId } from '@happier-dev/protocol';
import {
  createClaudeUnifiedProviderInputOutcomeBridge,
  type ClaudeUnifiedProviderInputOutcomeBridge,
} from '../unifiedTerminal/claudeUnifiedProviderInputOutcome';

const CLAUDE_REMOTE_PROVIDER_INPUT_PRODUCER = Object.freeze({
  providerId: 'claude',
  mode: 'remote',
  matchesCurrentSession: ({ metadata }) => {
    if (!metadata || typeof metadata !== 'object') return false;
    const flavor = readNonBlankOpaqueIdentifier((metadata as Record<string, unknown>).flavor);
    return flavor === null || flavor === 'claude';
  },
}) satisfies SessionProviderInputOutcomeProducer;

type BindingClient = Readonly<{
  bindProviderInputOutcomeProducer?: (
    producer: SessionProviderInputOutcomeProducer,
  ) => SessionProviderInputOutcomeObserver;
}>;

export function createClaudeRemoteProviderInputOutcomeBridge(client: object) {
  const observe = (client as BindingClient).bindProviderInputOutcomeProducer?.(
    CLAUDE_REMOTE_PROVIDER_INPUT_PRODUCER,
  ) ?? null;
  const readExactLocalId = (localIds: readonly string[] | null | undefined): string | null => {
    if (localIds?.length !== 1) return null;
    return readPendingLocalId(localIds[0]);
  };
  return Object.freeze({
    observeAccepted: (
      localIds: readonly string[] | null | undefined,
      appliedModelId?: string | null,
    ): boolean => {
      const localId = readExactLocalId(localIds);
      if (!observe || localId === null) return false;
      const normalizedAppliedModelId = readNonBlankOpaqueIdentifier(appliedModelId);
      observe({
        kind: 'accepted',
        localId,
        ...(normalizedAppliedModelId ? { appliedModelId: normalizedAppliedModelId } : {}),
      });
      return true;
    },
    observeRejectedBeforeEffect: (input: Readonly<{
      userMessageLocalIds: readonly string[] | null | undefined;
      reason: SessionProviderInputRejectedBeforeEffectReason;
    }>): boolean => {
      const localId = readExactLocalId(input.userMessageLocalIds);
      if (!observe || localId === null) return false;
      observe({
        kind: 'rejected_before_effect',
        localId,
        reason: input.reason,
      });
      return true;
    },
    observeEffectMayHaveOccurred: (input: Readonly<{
      userMessageLocalIds: readonly string[] | null | undefined;
    }>): boolean => {
      const localId = readExactLocalId(input.userMessageLocalIds);
      if (!observe || localId === null) return false;
      observe({ kind: 'effect_may_have_occurred', localId });
      return true;
    },
    hasAccepted: (localIds: readonly string[] | null | undefined): boolean => {
      const localId = readExactLocalId(localIds);
      return localId !== null
        && (client as { hasPendingProviderInputAcceptance?: (value: string) => boolean })
          .hasPendingProviderInputAcceptance?.(localId) === true;
    },
  });
}

/**
 * Bind the inline Remote Unified runner through the same producer and generation fence as the
 * standalone Unified launcher. Call once for each terminal-host generation.
 */
export function createClaudeRemoteUnifiedProviderInputOutcomeGeneration(
  client: object,
  options?: Readonly<{ isCurrentRuntimeMode?: (() => boolean) | undefined }>,
): ClaudeUnifiedProviderInputOutcomeBridge {
  return createClaudeUnifiedProviderInputOutcomeBridge(client, options);
}
