import { describe, expect, it, vi } from 'vitest';

import { createGeminiAcpProviderInputOutcomeBridge } from './geminiAcpProviderInputOutcome';
import type { SessionProviderInputOutcomeProducer } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';

describe('createGeminiAcpProviderInputOutcomeBridge', () => {
  it('emits typed Gemini ACP outcomes for one exact opaque local id without changing its bytes', () => {
    const observe = vi.fn();
    const bindProviderInputOutcomeProducer = vi.fn((_producer: SessionProviderInputOutcomeProducer) => observe);
    const bridge = createGeminiAcpProviderInputOutcomeBridge({ bindProviderInputOutcomeProducer });

    expect(bridge.observeAccepted({
      userMessageLocalIds: [' exact-local-id '],
      appliedModelId: 'gemini-2.5-pro',
    })).toBe(true);
    expect(bridge.observeAccepted({
      userMessageLocalIds: ['   '],
    })).toBe(false);
    expect(bridge.observeRejectedBeforeEffect({
      userMessageLocalIds: ['rejected-local-id'],
      reason: 'runtime_disposed_before_delivery',
    })).toBe(true);
    expect(bridge.observeEffectMayHaveOccurred({
      userMessageLocalIds: ['ambiguous-local-id'],
    })).toBe(true);

    expect(bindProviderInputOutcomeProducer).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'gemini',
      mode: 'acp',
      matchesCurrentSession: expect.any(Function),
    }));
    const producer = bindProviderInputOutcomeProducer.mock.calls[0]?.[0];
    expect(producer?.matchesCurrentSession({ metadata: { flavor: 'gemini' } as Metadata })).toBe(true);
    expect(producer?.matchesCurrentSession({ metadata: { flavor: 'claude' } as Metadata })).toBe(false);
    expect(observe.mock.calls).toEqual([
      [{ kind: 'accepted', localId: ' exact-local-id ', appliedModelId: 'gemini-2.5-pro' }],
      [{
        kind: 'rejected_before_effect',
        localId: 'rejected-local-id',
        reason: 'runtime_disposed_before_delivery',
      }],
      [{ kind: 'effect_may_have_occurred', localId: 'ambiguous-local-id' }],
    ]);
  });

  it('fails closed for missing, multiple, or blank local identities', () => {
    const observe = vi.fn();
    const bridge = createGeminiAcpProviderInputOutcomeBridge({
      bindProviderInputOutcomeProducer: () => observe,
    });

    expect(bridge.observeAccepted({ userMessageLocalIds: [] })).toBe(false);
    expect(bridge.observeAccepted({ userMessageLocalIds: ['a', 'b'] })).toBe(false);
    expect(bridge.observeAccepted({ userMessageLocalIds: [''] })).toBe(false);
    expect(bridge.observeAccepted({ userMessageLocalIds: ['   '] })).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  });

  it('fails closed when the session client has no typed outcome binding', () => {
    const bridge = createGeminiAcpProviderInputOutcomeBridge({});

    expect(bridge.observeAccepted({
      userMessageLocalIds: ['exact-local'],
    })).toBe(false);
  });
});
