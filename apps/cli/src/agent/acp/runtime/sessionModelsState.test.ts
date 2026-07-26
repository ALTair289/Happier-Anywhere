import { describe, expect, it } from 'vitest';

import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { normalizeConfigOptionsArray, publishAcpSessionModelsState } from './sessionModelsState';

describe('normalizeConfigOptionsArray', () => {
  it('preserves exact nonblank config identifiers and values', () => {
    expect(normalizeConfigOptionsArray([{
      id: ' effort ',
      name: 'Effort',
      type: 'select',
      currentValue: ' high ',
      options: [
        { value: ' high ', name: 'High exact' },
        { value: 'high', name: 'High distinct' },
      ],
    }])).toEqual([{
      id: ' effort ',
      name: 'Effort',
      type: 'select',
      currentValue: ' high ',
      options: [
        { value: ' high ', name: 'High exact' },
        { value: 'high', name: 'High distinct' },
      ],
    }]);
  });
});

describe('publishAcpSessionModelsState', () => {
  it('preserves available models from the newest valid alias during partial model updates', () => {
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata({
        sessionModelsV1: {
          v: 1,
          provider: 'gemini',
          updatedAt: 20,
          currentModelId: 'gemini-new',
          availableModels: [{ id: 'gemini-new', name: 'Gemini New' }],
        },
        acpSessionModelsV1: {
          v: 1,
          provider: 'gemini',
          updatedAt: 10,
          currentModelId: 'gemini-stale',
          availableModels: [{ id: 'gemini-stale', name: 'Gemini Stale' }],
        },
      }),
    });

    publishAcpSessionModelsState({
      session,
      provider: 'gemini',
      payload: { currentModelId: 'gemini-next' },
      logPrefix: '[test]',
      reason: 'current_model_update',
      preservePreviousAvailableModels: true,
    });

    expect(getMetadata().sessionModelsV1).toMatchObject({
      currentModelId: 'gemini-next',
      availableModels: [{ id: 'gemini-new', name: 'Gemini New' }],
    });
    expect(getMetadata().acpSessionModelsV1).toEqual(getMetadata().sessionModelsV1);
  });
});
