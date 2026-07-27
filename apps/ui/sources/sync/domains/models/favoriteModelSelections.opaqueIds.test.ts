import { describe, expect, it } from 'vitest';

import {
  buildFavoriteModelAvailabilityById,
  normalizeFavoriteModelId,
  toggleFavoriteModelSelection,
} from './favoriteModelSelections';

describe('favorite model opaque identifiers', () => {
  it('validates without transforming model identifiers', () => {
    expect(normalizeFavoriteModelId(' model-a\t')).toBe(' model-a\t');
    expect(normalizeFavoriteModelId('   ')).toBe('');
  });

  it('keeps trim-colliding provider model identifiers distinct in availability and favorites', () => {
    const availability = buildFavoriteModelAvailabilityById({
      mode: 'dynamic',
      modelOptions: [],
      preflightModels: {
        availableModels: [
          { id: 'model-a', name: 'Plain' },
          { id: ' model-a ', name: 'Spaced' },
        ],
        supportsFreeform: false,
      },
    });
    expect([...availability.keys()]).toEqual(['model-a', ' model-a ']);

    const backend = { backendTargetKey: 'agent:cursor', providerAgentId: 'cursor' };
    const first = toggleFavoriteModelSelection({ favorites: [], backend, modelId: 'model-a' });
    const second = toggleFavoriteModelSelection({ favorites: first, backend, modelId: ' model-a ' });
    expect(second.map((entry) => entry.modelId)).toEqual(['model-a', ' model-a ']);
  });
});
