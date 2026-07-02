import { describe, expect, it } from 'vitest';

import { parseSessionCreateSpawnOptions } from './parseSessionCreateSpawnOptions';

describe('parseSessionCreateSpawnOptions', () => {
  it('normalizes rich create flags into generic spawn action input', () => {
    const parsed = parseSessionCreateSpawnOptions(
      [
        '--path',
        '/repo',
        '--backend',
        'agent:claude',
        '--title',
        'Spawn title',
        '--tag',
        'spawn-tag',
        '--prompt',
        'Start here',
        '--model',
        'claude-opus-4-8',
        '--permission-mode',
        'acceptEdits',
        '--mode',
        'plan',
        '--config-option',
        'reasoning_effort=xhigh',
        '--config-option',
        'temperature=0.4',
        '--ultracode',
      ],
      { nowMs: 1_710_000_000_000 },
    );

    expect(parsed).toEqual({
      backendRaw: 'agent:claude',
      backendTargetKey: 'agent:claude',
      actionInput: {
        path: '/repo',
        backendTargetKey: 'agent:claude',
        title: 'Spawn title',
        tag: 'spawn-tag',
        initialMessage: 'Start here',
        modelId: 'claude-opus-4-8',
        permissionMode: 'acceptEdits',
        agentModeId: 'plan',
        sessionConfigOptionOverrides: {
          v: 1,
          updatedAt: 1_710_000_000_000,
          overrides: {
            reasoning_effort: { updatedAt: 1_710_000_000_000, value: 'xhigh' },
            temperature: { updatedAt: 1_710_000_000_000, value: 0.4 },
            ultracode: { updatedAt: 1_710_000_000_000, value: true },
          },
        },
      },
    });
  });

  it('merges --config-overrides-json with convenience config flags', () => {
    const parsed = parseSessionCreateSpawnOptions(
      [
        '--config-overrides-json',
        JSON.stringify({
          v: 1,
          updatedAt: 10,
          overrides: {
            reasoning_effort: { updatedAt: 10, value: 'high' },
          },
        }),
        '--config-option',
        'foo=true',
        '--ultracode',
      ],
      { nowMs: 20 },
    );

    expect(parsed.actionInput).toEqual(expect.objectContaining({
      agentId: 'claude',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 20,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'high' },
          foo: { updatedAt: 20, value: true },
          ultracode: { updatedAt: 20, value: true },
        },
      },
    }));
  });

  it('rejects malformed config override JSON without echoing the value', () => {
    expect(() => parseSessionCreateSpawnOptions(
      ['--config-overrides-json', '{"secret":"do-not-print"'],
      { nowMs: 20 },
    )).toThrow('Invalid --config-overrides-json');
  });
});
