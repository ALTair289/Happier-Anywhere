import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function cursorAcpStubProvider(): ProviderUnderTest {
  return {
    id: 'cursor_acp_stub',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_CURSOR_ACP_STUB',
    protocol: 'acp',
    traceProvider: 'cursor',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: 'cursor' },
  };
}

describe('scenarioCatalog: Cursor ACP stub parity scenarios', () => {
  it('discovers the deterministic Cursor ACP stub provider spec', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const cursorStub = providers.find((provider) => provider.id === 'cursor_acp_stub');

    expect(cursorStub).toBeTruthy();
    expect(cursorStub?.traceProvider).toBe('cursor');
    expect(cursorStub?.cli.subcommand).toBe('cursor');
    expect(cursorStub?.cli.env?.HAPPIER_E2E_ACP_TRACE_MARKERS).toBe('1');
    expect(cursorStub?.scenarioRegistry.tiers.smoke).toEqual([
      'cursor_acp_stub_model_config_alias',
      'cursor_acp_stub_mode_config_option',
      'cursor_acp_stub_extension_plan_todos',
    ]);
    expect(cursorStub?.scenarioRegistry.tiers.extended).toEqual([
      'cursor_acp_stub_captured_lifecycle_replay',
    ]);
  });

  it('defines a Cursor alias/config-option scenario that verifies normalized ACP payloads', () => {
    const build = (scenarioCatalog as Record<string, unknown>).cursor_acp_stub_model_config_alias;
    expect(typeof build).toBe('function');

    const scenario = (build as (provider: ProviderUnderTest) => unknown)(cursorAcpStubProvider()) as {
      id?: unknown;
      requiredTraceSubstrings?: unknown;
      requiredMessageSubstrings?: unknown;
      cliArgs?: unknown;
      postSatisfy?: { run?: unknown };
      verify?: unknown;
    };

    expect(scenario.id).toBe('cursor_acp_stub_model_config_alias');
    expect(typeof scenario.cliArgs).toBe('function');
    expect((scenario.cliArgs as () => string[])()).toEqual([
      '--model',
      'gpt-5.1-codex-max-medium-fast',
      '--model-updated-at',
      expect.any(String),
    ]);
    expect(scenario.requiredTraceSubstrings).toEqual(['task_complete']);
    expect(scenario.requiredMessageSubstrings).toBeUndefined();
    expect(typeof scenario.postSatisfy?.run).toBe('function');
    expect(typeof scenario.verify).toBe('function');
  });

  it('defines a Cursor mode config-option scenario that verifies live mode payloads', () => {
    const build = (scenarioCatalog as Record<string, unknown>).cursor_acp_stub_mode_config_option;
    expect(typeof build).toBe('function');

    const scenario = (build as (provider: ProviderUnderTest) => unknown)(cursorAcpStubProvider()) as {
      id?: unknown;
      requiredTraceSubstrings?: unknown;
      cliArgs?: unknown;
      postSatisfy?: { run?: unknown };
      verify?: unknown;
    };

    expect(scenario.id).toBe('cursor_acp_stub_mode_config_option');
    expect(typeof scenario.cliArgs).toBe('function');
    expect((scenario.cliArgs as () => string[])()).toEqual([
      '--agent-mode',
      'plan',
      '--agent-mode-updated-at',
      expect.any(String),
    ]);
    expect(scenario.requiredTraceSubstrings).toEqual(['task_complete']);
    expect(typeof scenario.postSatisfy?.run).toBe('function');
    expect(typeof scenario.verify).toBe('function');
  });

  it('defines a Cursor extension UX scenario for plan and todo work-state surfaces', () => {
    const build = (scenarioCatalog as Record<string, unknown>).cursor_acp_stub_extension_plan_todos;
    expect(typeof build).toBe('function');

    const scenario = (build as (provider: ProviderUnderTest) => unknown)(cursorAcpStubProvider()) as {
      id?: unknown;
      requiredTraceSubstrings?: unknown;
      requiredMessageSubstrings?: unknown;
      verify?: unknown;
    };

    expect(scenario.id).toBe('cursor_acp_stub_extension_plan_todos');
    expect(scenario.requiredTraceSubstrings).toEqual(['task_complete']);
    expect(scenario.requiredMessageSubstrings).toBeUndefined();
    expect(typeof scenario.verify).toBe('function');
  });

  it('defines the captured lifecycle replay as a deterministic extended scenario', () => {
    const build = (scenarioCatalog as Record<string, unknown>).cursor_acp_stub_captured_lifecycle_replay;
    expect(typeof build).toBe('function');

    const scenario = (build as (provider: ProviderUnderTest) => unknown)(cursorAcpStubProvider()) as {
      id?: unknown;
      tier?: unknown;
      prompt?: unknown;
      requiredTraceSubstrings?: unknown;
      resume?: unknown;
      verify?: unknown;
    };

    expect(scenario.id).toBe('cursor_acp_stub_captured_lifecycle_replay');
    expect(scenario.tier).toBe('extended');
    expect(typeof scenario.prompt).toBe('function');
    expect(scenario.requiredTraceSubstrings).toEqual(['task_complete']);
    expect(scenario.resume).toEqual({
      metadataKey: 'cursorSessionId',
      freshSession: true,
      prompt: expect.any(Function),
      requiredTraceSubstrings: ['task_complete'],
    });
    expect(typeof scenario.verify).toBe('function');
  });
});
