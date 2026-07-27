import { describe, expect, it, vi } from 'vitest';

import { listCursorAvailableModels } from '../listAvailableModels';

describe('listCursorAvailableModels', () => {
  it('uses the provider-neutral requester with the Cursor-owned method and timeout', async () => {
    const request = vi.fn(async () => ({
      models: [{ value: 'model-a', name: 'Model A' }],
    }));

    await expect(listCursorAvailableModels({ request, timeoutMs: 321 })).resolves.toEqual([
      { value: 'model-a', name: 'Model A' },
    ]);
    expect(request).toHaveBeenCalledWith('cursor/list_available_models', {}, { timeoutMs: 321 });
  });

  it('preserves exact opaque model, config, and choice identifiers', async () => {
    await expect(listCursorAvailableModels({
      request: async () => ({
        models: [{
          value: ' model-a ',
          name: 'Model A',
          configOptions: [{
            id: ' effort ',
            name: 'Effort',
            category: ' model_config ',
            type: 'select',
            currentValue: ' high ',
            options: [
              { value: ' high ', name: 'High' },
              { value: 'high', name: 'Distinct high' },
            ],
          }],
        }],
      }),
      timeoutMs: 100,
    })).resolves.toEqual([{
      value: ' model-a ',
      name: 'Model A',
      configOptions: [{
        id: ' effort ',
        name: 'Effort',
        category: ' model_config ',
        type: 'select',
        currentValue: ' high ',
        options: [
          { value: ' high ', name: 'High' },
          { value: 'high', name: 'Distinct high' },
        ],
      }],
    }]);
  });

  it('fails closed on malformed or oversized model entries', async () => {
    await expect(listCursorAvailableModels({
      request: async () => ({ models: [{ value: '', name: 'Missing id' }] }),
      timeoutMs: 100,
    })).rejects.toThrow();
    await expect(listCursorAvailableModels({
      request: async () => ({
        models: Array.from({ length: 513 }, (_, index) => ({ value: `m${index}`, name: `M${index}` })),
      }),
      timeoutMs: 100,
    })).rejects.toThrow();
  });

  it('rejects non-standard select config options instead of projecting a malformed control', async () => {
    await expect(listCursorAvailableModels({
      request: async () => ({
        models: [{
          value: 'model-a',
          name: 'Model A',
          configOptions: [{
            id: 'effort',
            name: 'Effort',
            type: 'select',
            currentValue: true,
            options: [{ value: true, name: 'On' }],
          }],
        }],
      }),
      timeoutMs: 100,
    })).rejects.toThrow();

    await expect(listCursorAvailableModels({
      request: async () => ({
        models: [{
          value: 'model-a',
          name: 'Model A',
          configOptions: [{
            id: 'effort',
            name: 'Effort',
            type: 'select',
            currentValue: 'high',
          }],
        }],
      }),
      timeoutMs: 100,
    })).rejects.toThrow();
  });
});
