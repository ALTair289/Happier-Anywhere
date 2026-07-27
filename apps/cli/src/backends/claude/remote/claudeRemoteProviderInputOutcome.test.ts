import { describe, expect, it, vi } from 'vitest';

import type {
  SessionProviderInputOutcome,
  SessionProviderInputOutcomeProducer,
} from '@/api/session/sessionClient';

import { createClaudeRemoteUnifiedProviderInputOutcomeGeneration } from './claudeRemoteProviderInputOutcome';
import { createClaudeRemoteProviderInputOutcomeBridge } from './claudeRemoteProviderInputOutcome';

describe('createClaudeRemoteProviderInputOutcomeBridge', () => {
  it('normalizes exact non-Unified pre-effect and ambiguous transport failures', () => {
    const observed: SessionProviderInputOutcome[] = [];
    const client = {
      bindProviderInputOutcomeProducer: vi.fn((_producer: SessionProviderInputOutcomeProducer) => (
        outcome: SessionProviderInputOutcome,
      ) => observed.push(outcome)),
    };
    const bridge = createClaudeRemoteProviderInputOutcomeBridge(client);

    expect(bridge.observeRejectedBeforeEffect({
      userMessageLocalIds: ['pre-effect-local-id'],
      reason: 'provider_unavailable_before_acceptance',
    })).toBe(true);
    expect(bridge.observeEffectMayHaveOccurred({
      userMessageLocalIds: ['ambiguous-local-id'],
    })).toBe(true);

    expect(observed).toEqual([
      {
        kind: 'rejected_before_effect',
        localId: 'pre-effect-local-id',
        reason: 'provider_unavailable_before_acceptance',
      },
      { kind: 'effect_may_have_occurred', localId: 'ambiguous-local-id' },
    ]);
  });
});

describe('createClaudeRemoteUnifiedProviderInputOutcomeGeneration', () => {
  it('binds each terminal generation to the canonical Unified producer fence', () => {
    const observed: SessionProviderInputOutcome[] = [];
    let currentGeneration = 0;
    const bindProviderInputOutcomeProducer = vi.fn((producer: SessionProviderInputOutcomeProducer) => {
      expect(producer).toMatchObject({ providerId: 'claude', mode: 'unifiedTerminal' });
      const generation = ++currentGeneration;
      return (outcome: SessionProviderInputOutcome) => {
        if (generation === currentGeneration) observed.push(outcome);
      };
    });
    const client = { bindProviderInputOutcomeProducer };

    const replaced = createClaudeRemoteUnifiedProviderInputOutcomeGeneration(client, {
      isCurrentRuntimeMode: () => true,
    });
    const current = createClaudeRemoteUnifiedProviderInputOutcomeGeneration(client, {
      isCurrentRuntimeMode: () => true,
    });

    replaced.observeEffectMayHaveOccurred({ userMessageLocalIds: ['same-local-id'] });
    replaced.observeAccepted({ userMessageLocalIds: ['same-local-id'] });
    current.observeEffectMayHaveOccurred({ userMessageLocalIds: ['same-local-id'] });
    current.observeAccepted({
      userMessageLocalIds: ['same-local-id'],
      appliedModelId: 'claude-opus-4-6',
    });

    expect(bindProviderInputOutcomeProducer).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([
      { kind: 'effect_may_have_occurred', localId: 'same-local-id' },
      { kind: 'accepted', localId: 'same-local-id', appliedModelId: 'claude-opus-4-6' },
    ]);
  });
});
