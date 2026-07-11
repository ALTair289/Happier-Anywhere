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
        '--profile',
        'profile-1',
        '--env',
        'FEATURE_FLAG=enabled',
        '--env',
        'EMPTY_VALUE=',
        '--connected-services-json',
        JSON.stringify({
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'native' },
          },
        }),
        '--mcp-selection-json',
        JSON.stringify({
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['repo-tools'],
          forceExcludeServerIds: ['legacy-tool'],
        }),
        '--transcript-storage',
        'direct',
        '--terminal-json',
        JSON.stringify({
          mode: 'tmux',
          tmux: { sessionName: 'spawn', isolated: true },
        }),
        '--codex-backend-mode',
        'appServer',
        '--agent-runtime-descriptor-json',
        JSON.stringify({
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerExtra: { owner: 'codex', schemaId: 'codex.agentRuntimeDescriptorExtra', v: 1 },
          },
        }),
        '--host',
        'leeroy-mbp',
        '--machine-id',
        'machine-1',
      ],
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
        profileId: 'profile-1',
        environmentVariables: {
          FEATURE_FLAG: 'enabled',
          EMPTY_VALUE: '',
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'native' },
          },
        },
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['repo-tools'],
          forceExcludeServerIds: ['legacy-tool'],
        },
        transcriptStorage: 'direct',
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'spawn', isolated: true },
        },
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerExtra: { owner: 'codex', schemaId: 'codex.agentRuntimeDescriptorExtra', v: 1 },
          },
        },
        host: 'leeroy-mbp',
        machineId: 'machine-1',
        configOptions: {
          reasoning_effort: 'xhigh',
          temperature: 0.4,
          ultracode: true,
        },
      },
    });
  });

  it('keeps canonical --config-overrides-json separate from convenience config flags', () => {
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
    );

    expect(parsed.actionInput).toEqual(expect.objectContaining({
      agentId: 'claude',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'high' },
        },
      },
      configOptions: {
        foo: true,
        ultracode: true,
      },
    }));
  });

  it('rejects malformed config override JSON without echoing the value', () => {
    expect(() => parseSessionCreateSpawnOptions(
      ['--config-overrides-json', '{"secret":"do-not-print"'],
    )).toThrow('Invalid --config-overrides-json');
  });

  it('rejects malformed rich JSON flags without echoing values', () => {
    expect(() => parseSessionCreateSpawnOptions(
      ['--connected-services-json', '{"token":"do-not-print"'],
    )).toThrow('Invalid --connected-services-json');
  });
});
