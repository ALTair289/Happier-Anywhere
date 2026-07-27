import { describe, expect, it } from 'vitest';

import { projectCursorAvailableModels } from '../projectAvailableModels';

describe('projectCursorAvailableModels', () => {
  it('dedupes proprietary ids, retains per-model options, and appends standard-only models', () => {
    expect(projectCursorAvailableModels({
      proprietaryModels: [
        {
          value: 'a',
          name: 'Model A',
          configOptions: [{
            id: 'effort',
            name: 'Effort',
            category: 'model_config',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          }],
        },
        { value: 'a', name: 'Duplicate A' },
      ],
      standardProjection: {
        currentModelId: 'b',
        availableModels: [
          { id: 'a', name: 'Standard A' },
          { id: 'b', name: 'Standard B' },
        ],
      },
    })).toEqual({
      currentModelId: 'b',
      availableModels: [
        {
          id: 'a',
          name: 'Model A',
          modelOptions: [{
            id: 'effort',
            name: 'Effort',
            category: 'model_config',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          }],
        },
        { id: 'b', name: 'Standard B' },
      ],
    });
  });

  it('keeps whitespace-distinct exact option identifiers separate while merging contributions', () => {
    expect(projectCursorAvailableModels({
      proprietaryModels: [{
        value: ' model-a ',
        name: 'Model A',
        configOptions: [{
          id: ' effort ',
          name: 'Provider effort',
          type: 'select',
          currentValue: ' high ',
          options: [{ value: ' high ', name: 'High' }],
        }],
      }],
      standardProjection: {
        currentModelId: ' model-a ',
        availableModels: [{
          id: ' model-a ',
          name: 'Standard model A',
          modelOptions: [{
            id: 'effort',
            name: 'Standard effort',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          }],
        }],
      },
    })?.availableModels[0]?.modelOptions?.map((option) => option.id)).toEqual([
      ' effort ',
      'effort',
    ]);
  });
});
