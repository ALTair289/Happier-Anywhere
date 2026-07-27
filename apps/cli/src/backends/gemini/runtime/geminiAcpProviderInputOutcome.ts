import type {
  SessionProviderInputOutcomeObserver,
  SessionProviderInputOutcomeProducer,
  SessionProviderInputRejectedBeforeEffectReason,
} from '@/api/session/sessionClient';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { readPendingLocalId } from '@happier-dev/protocol';

const GEMINI_ACP_PROVIDER_INPUT_PRODUCER = Object.freeze({
  providerId: 'gemini',
  mode: 'acp',
  matchesCurrentSession: ({ metadata }) => {
    if (!metadata || typeof metadata !== 'object') return false;
    return readNonBlankOpaqueIdentifier((metadata as Record<string, unknown>).flavor) === 'gemini';
  },
}) satisfies SessionProviderInputOutcomeProducer;

type ProviderOutcomeBindingClient = Readonly<{
  bindProviderInputOutcomeProducer?: (
    producer: SessionProviderInputOutcomeProducer,
  ) => SessionProviderInputOutcomeObserver;
}>;

export type GeminiAcpProviderInputIdentity = Readonly<{
  userMessageLocalIds: readonly string[];
  appliedModelId?: string | null;
}>;

export type GeminiAcpProviderInputOutcomeBridge = Readonly<{
  observeAccepted: (input: GeminiAcpProviderInputIdentity) => boolean;
  observeRejectedBeforeEffect: (
    input: GeminiAcpProviderInputIdentity & Readonly<{
      reason: SessionProviderInputRejectedBeforeEffectReason;
    }>,
  ) => boolean;
  observeEffectMayHaveOccurred: (input: GeminiAcpProviderInputIdentity) => boolean;
}>;

function readExactIdentity(input: GeminiAcpProviderInputIdentity): Readonly<{ localId: string }> | null {
  if (input.userMessageLocalIds.length !== 1) return null;
  const localId = readPendingLocalId(input.userMessageLocalIds[0]);
  if (localId === null) return null;
  return { localId };
}

export function createGeminiAcpProviderInputOutcomeBridge(
  client: object,
): GeminiAcpProviderInputOutcomeBridge {
  const bindingClient = client as ProviderOutcomeBindingClient;
  const observe = bindingClient.bindProviderInputOutcomeProducer?.(
    GEMINI_ACP_PROVIDER_INPUT_PRODUCER,
  ) ?? null;
  const observeExact = (
    input: GeminiAcpProviderInputIdentity,
    emit: (
      observer: SessionProviderInputOutcomeObserver,
      identity: NonNullable<ReturnType<typeof readExactIdentity>>,
    ) => void,
  ): boolean => {
    if (!observe) return false;
    const identity = readExactIdentity(input);
    if (!identity) return false;
    emit(observe, identity);
    return true;
  };

  return Object.freeze({
    observeAccepted: (input) => observeExact(input, (observer, identity) => {
      const appliedModelId = readNonBlankOpaqueIdentifier(input.appliedModelId);
      observer({
        kind: 'accepted',
        ...identity,
        ...(appliedModelId ? { appliedModelId } : {}),
      });
    }),
    observeRejectedBeforeEffect: (input) => observeExact(input, (observer, identity) => {
      observer({ kind: 'rejected_before_effect', ...identity, reason: input.reason });
    }),
    observeEffectMayHaveOccurred: (input) => observeExact(input, (observer, identity) => {
      observer({ kind: 'effect_may_have_occurred', ...identity });
    }),
  });
}
