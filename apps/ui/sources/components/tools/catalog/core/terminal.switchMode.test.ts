import { describe, expect, it } from 'vitest';

import { coreTerminalTools } from './terminal';

describe('SwitchMode tool presentation', () => {
  it('stays honest with empty input and derives state from result or authoritative metadata', () => {
    const definition = coreTerminalTools.SwitchMode;
    const baseTool = {
      id: 'tool-1',
      name: 'SwitchMode',
      state: 'running',
      input: {},
      description: 'Switch Mode',
    } as any;

    expect(definition.extractSubtitle?.({ metadata: null, tool: baseTool })).toBeNull();
    expect(definition.extractSubtitle?.({
      metadata: null,
      tool: { ...baseTool, state: 'completed', result: { currentModeId: 'plan' } },
    })).toBe('plan');
    expect(definition.extractSubtitle?.({
      metadata: {
        sessionModesV1: {
          v: 1,
          provider: 'cursor',
          updatedAt: 1,
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      } as any,
      tool: baseTool,
    })).toBe('Plan');
  });
});
