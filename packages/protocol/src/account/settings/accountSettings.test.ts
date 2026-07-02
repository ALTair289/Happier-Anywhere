import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from './accountSettings.js';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from './connectedServicesSettings.js';
import { isActionEnabledByActionsSettings } from '../../actions/actionSettings.js';

describe('accountSettings', () => {
  it('defaults usage-limit recovery to asking before waiting', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'ask',
      promptMode: 'standard',
      resumePromptMode: 'standard',
    });
  });

  it('accepts remembered automatic usage-limit wait recovery', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'auto_wait',
      },
    });

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'auto_wait',
      promptMode: 'standard',
      resumePromptMode: 'standard',
    });
  });

  it('preserves disabled resume prompts for usage-limit recovery', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'auto_wait',
        resumePromptMode: 'off',
      },
    });

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'auto_wait',
      promptMode: 'standard',
      resumePromptMode: 'off',
    });
  });

  it('accepts a custom resume prompt mode with trimmed custom text', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'auto_wait',
        resumePromptMode: 'custom',
        customResumePrompt: '  Pick up the task again.  ',
      },
    });

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'auto_wait',
      promptMode: 'standard',
      resumePromptMode: 'custom',
      customResumePrompt: 'Pick up the task again.',
    });
  });

  it('falls back to asking when usage-limit recovery settings are malformed', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'switch_accounts',
      },
    });

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'ask',
      promptMode: 'standard',
      resumePromptMode: 'standard',
    });
  });

  it('defaults the session provider usage gauge to automatic most-constrained display', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.sessionProviderUsageSettingsV1).toEqual({
      v: 1,
      gaugeMode: 'auto',
      gaugeWindowMode: 'most_constrained',
    });
  });

  it('defaults pending queue draining to one message per wake', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.sessionPendingQueueDrainMode).toBe('one_at_a_time');
  });

  it('accepts drain-all pending queue mode and falls back to one-at-a-time for malformed values', () => {
    expect(accountSettingsParse({ sessionPendingQueueDrainMode: 'drain_all' }).sessionPendingQueueDrainMode).toBe('drain_all');
    expect(accountSettingsParse({ sessionPendingQueueDrainMode: 'everything' }).sessionPendingQueueDrainMode).toBe('one_at_a_time');
  });

  it('defaults pending queue delivery timing to foreground-ready and falls back for malformed values', () => {
    expect(accountSettingsParse({}).sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');
    expect(accountSettingsParse({
      sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
    }).sessionPendingQueueDeliveryTiming).toBe('after_runtime_idle');
    expect(accountSettingsParse({
      sessionPendingQueueDeliveryTiming: 'after_everything',
    }).sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');
  });

  it('defaults connected-service provider state sharing to shared configuration and shared session state', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.connectedServicesProviderStateSharingSettingsV1).toEqual({
      v: 1,
      defaults: {
        configMode: 'linked',
        stateMode: 'shared',
      },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
  });

  it('resolves shared session state by default for supported providers', () => {
    const parsed = accountSettingsParse({});

    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      parsed.connectedServicesProviderStateSharingSettingsV1,
      'codex',
    )).toEqual({
      configMode: 'linked',
      stateMode: 'shared',
    });
  });

  it('lets a per-agent override opt out of shared session state (defaults stay shared)', () => {
    const parsed = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        byAgentId: {
          codex: {
            stateMode: 'isolated',
          },
        },
      },
    });

    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      parsed.connectedServicesProviderStateSharingSettingsV1,
      'codex',
    )).toEqual({
      configMode: 'linked',
      stateMode: 'isolated',
    });
    // Other agents keep the shared default.
    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      parsed.connectedServicesProviderStateSharingSettingsV1,
      'pi',
    )).toEqual({
      configMode: 'linked',
      stateMode: 'shared',
    });
  });

  it('lets the defaults opt out of shared session state for every provider', () => {
    const parsed = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'linked',
          stateMode: 'isolated',
        },
      },
    });

    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      parsed.connectedServicesProviderStateSharingSettingsV1,
      'codex',
    )).toEqual({
      configMode: 'linked',
      stateMode: 'isolated',
    });
  });

  it('accepts provider-specific connected-service state sharing overrides', () => {
    const parsed = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'copied',
          stateMode: 'isolated',
        },
        byAgentId: {
          codex: {
            stateMode: 'shared',
          },
          pi: {
            configMode: 'isolated',
          },
        },
        acknowledgedRisksByAgentId: {
          codex: {
            sharedStatePrivacy: true,
          },
        },
      },
    });

    expect(parsed.connectedServicesProviderStateSharingSettingsV1).toEqual({
      v: 1,
      defaults: {
        configMode: 'copied',
        stateMode: 'isolated',
      },
      byAgentId: {
        codex: {
          stateMode: 'shared',
        },
        pi: {
          configMode: 'isolated',
        },
      },
      acknowledgedRisksByAgentId: {
        codex: {
          sharedStatePrivacy: true,
        },
      },
    });
  });

  it('resolves effective connected-service provider state sharing policy by agent id', () => {
    const settings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'copied',
          stateMode: 'isolated',
        },
        byAgentId: {
          codex: {
            stateMode: 'shared',
          },
          pi: {
            configMode: 'isolated',
          },
        },
      },
    });

    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      settings.connectedServicesProviderStateSharingSettingsV1,
      'codex',
    )).toEqual({
      configMode: 'copied',
      stateMode: 'shared',
    });
    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      settings.connectedServicesProviderStateSharingSettingsV1,
      'pi',
    )).toEqual({
      configMode: 'isolated',
      stateMode: 'isolated',
    });
    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      settings.connectedServicesProviderStateSharingSettingsV1,
      'gemini',
    )).toEqual({
      configMode: 'copied',
      stateMode: 'isolated',
    });
  });

  it('falls back to provider state sharing defaults when the setting is malformed', () => {
    const parsed = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'hardlink',
          stateMode: 'detached',
        },
      },
    });

    expect(parsed.connectedServicesProviderStateSharingSettingsV1).toEqual({
      v: 1,
      defaults: {
        configMode: 'linked',
        stateMode: 'shared',
      },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
  });

  it('defaults connected-service default auth by agent to native', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.connectedServicesDefaultAuthByAgentIdV1).toEqual({
      v: 1,
      bindingsByAgentId: {},
    });
  });

  it('accepts connected-service default auth bindings by agent', () => {
    const parsed = accountSettingsParse({
      connectedServicesDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          codex: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                groupId: 'codex-main',
              },
            },
          },
          claude: {
            v: 1,
            bindingsByServiceId: {
              anthropic: {
                source: 'connected',
                profileId: 'work',
              },
            },
          },
        },
      },
    });

    expect(parsed.connectedServicesDefaultAuthByAgentIdV1).toEqual({
      v: 1,
      bindingsByAgentId: {
        codex: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'codex-main',
            },
          },
        },
        claude: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'profile',
              profileId: 'work',
            },
          },
        },
      },
    });
  });

  it('falls back to native defaults when connected-service default auth settings are malformed', () => {
    const parsed = accountSettingsParse({
      connectedServicesDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          codex: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'profile',
              },
            },
          },
        },
      },
    });

    expect(parsed.connectedServicesDefaultAuthByAgentIdV1).toEqual({
      v: 1,
      bindingsByAgentId: {},
    });
  });

  it('accepts hiding the session provider usage gauge', () => {
    const parsed = accountSettingsParse({
      sessionProviderUsageSettingsV1: {
        v: 1,
        gaugeMode: 'hidden',
        gaugeWindowMode: 'weekly',
      },
    });

    expect(parsed.sessionProviderUsageSettingsV1).toEqual({
      v: 1,
      gaugeMode: 'hidden',
      gaugeWindowMode: 'weekly',
    });
  });

  it('defaults connected-service notification topics to enabled', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.notificationsSettingsV1.connectedServiceAccountSwitch).toBe(true);
    expect(parsed.notificationsSettingsV1.connectedServiceQuotaBlocked).toBe(true);
    expect(parsed.notificationsSettingsV1.connectedServiceQuotaRecovered).toBe(true);
  });

  it('defaults connected-service quota recovered notifications from quota blocked notifications', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        connectedServiceQuotaBlocked: false,
      },
    });

    expect(parsed.notificationsSettingsV1.connectedServiceQuotaBlocked).toBe(false);
    expect(parsed.notificationsSettingsV1.connectedServiceQuotaRecovered).toBe(false);
  });

  it('preserves unknown account settings next to usage-limit recovery settings', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'auto_wait',
      },
      futureUsageLimitRecoveryScopeV2: {
        providers: {
          codex: true,
        },
      },
    });

    expect(parsed.futureUsageLimitRecoveryScopeV2).toEqual({
      providers: {
        codex: true,
      },
    });
  });

  it('defaults coding prompt behavior to current agent-managed behavior', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'ongoing',
      responseOptions: 'agent',
    });
  });

  it('normalizes legacy agent-managed title updates to ongoing title updates', () => {
    const parsed = accountSettingsParse({
      codingPromptBehaviorV1: {
        v: 1,
        sessionTitleUpdates: 'agent',
        responseOptions: 'agent',
      },
    });

    expect(parsed.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'ongoing',
      responseOptions: 'agent',
    });
  });

  it('accepts initial-only coding prompt title updates', () => {
    const parsed = accountSettingsParse({
      codingPromptBehaviorV1: {
        v: 1,
        sessionTitleUpdates: 'initial',
        responseOptions: 'agent',
      },
    });

    expect(parsed.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'initial',
      responseOptions: 'agent',
    });
  });

  it('accepts disabled coding prompt behavior options', () => {
    const parsed = accountSettingsParse({
      codingPromptBehaviorV1: {
        v: 1,
        sessionTitleUpdates: 'disabled',
        responseOptions: 'disabled',
      },
    });

    expect(parsed.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'disabled',
      responseOptions: 'disabled',
    });
  });

  it('defaults ready notification preview settings to enabled', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.notificationsSettingsV1.readyIncludeMessageText).toBe(true);
  });

  it('accepts explicit ready notification preview settings', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: false,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
    });

    expect(parsed.notificationsSettingsV1.readyIncludeMessageText).toBe(false);
  });

  it('defaults target-keyed backend settings maps', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.backendEnabledByTargetKey).toEqual({});
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({});
  });

  it('accepts target-keyed backend settings', () => {
    const parsed = accountSettingsParse({
      backendEnabledByTargetKey: {
        'agent:claude': true,
        'acpBackend:team-review': false,
      },
      backendCliSourcePreferenceByTargetKey: {
        'agent:claude': 'system-first',
        'acpBackend:team-review': 'managed-first',
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({
      'agent:claude': true,
      'acpBackend:team-review': false,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'agent:claude': 'system-first',
      'acpBackend:team-review': 'managed-first',
    });
  });

  it('backfills target-keyed backend settings from legacy id-keyed fields', () => {
    const parsed = accountSettingsParse({
      backendEnabledById: {
        claude: false,
        codex: true,
      },
      backendCliSourcePreferenceById: {
        claude: 'managed-first',
        codex: 'system-first',
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({
      'agent:claude': false,
      'agent:codex': true,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'agent:claude': 'managed-first',
      'agent:codex': 'system-first',
    });
  });

  it('prefers target-keyed backend settings when both schemas are present', () => {
    const parsed = accountSettingsParse({
      backendEnabledById: {
        claude: false,
      },
      backendEnabledByTargetKey: {
        'agent:claude': true,
      },
      backendCliSourcePreferenceById: {
        claude: 'managed-first',
      },
      backendCliSourcePreferenceByTargetKey: {
        'agent:claude': 'system-first',
      },
      futureField: {
        keep: true,
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({
      'agent:claude': true,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'agent:claude': 'system-first',
    });
    expect(parsed.futureField).toEqual({ keep: true });
  });

  it('defaults session-agent coordination controls to allowed while keeping destructive controls disabled', () => {
    const parsed = accountSettingsParse({});
    const settings = parsed.actionsSettingsV1;

    // External/CLI control plane remains enabled by default.
    expect(isActionEnabledByActionsSettings('session.stop' as any, settings, { surface: 'mcp' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.stop' as any, settings, { surface: 'cli' } as any)).toBe(true);

    // Destructive/product-courtesy controls remain opt-in.
    expect(isActionEnabledByActionsSettings('session.stop' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.archive' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.unarchive' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.permission.respond' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.user_action.answer' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.usageLimit.consumeResetCredit' as any, settings, { surface: 'session_agent' } as any)).toBe(false);

    // Spawn, coordination, reads, and useful runtime mutations are allowed by default.
    expect(isActionEnabledByActionsSettings('session.spawn_new' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.title.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.message.send' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.list' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.status.get' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.transcript.get' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.events.get' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.permission_mode.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.model.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.mode.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.usageLimit.waitResume.enable' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.usageLimit.waitResume.cancel' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.usageLimit.checkNow' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
  });

  it('defaults session-agent spawn override policy to allowing explicit overrides', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.sessionAgentSpawnPolicyV1).toEqual({
      v: 1,
      allowCustomDirectory: true,
      allowCrossMachine: true,
      allowBackendTargetOverride: true,
      allowModelOverride: true,
      allowPermissionModeOverride: true,
      allowAgentModeOverride: true,
      allowConfigOptionOverrides: true,
      allowProfileOverride: true,
      allowEnvironmentVariables: true,
      allowConnectedServicesOverride: true,
      allowMcpSelectionOverride: true,
      allowTranscriptStorageOverride: true,
      permissionCeiling: null,
    });
  });

  it('accepts session-agent spawn override policy restrictions', () => {
    const parsed = accountSettingsParse({
      sessionAgentSpawnPolicyV1: {
        v: 1,
        allowCustomDirectory: false,
        allowEnvironmentVariables: false,
        allowMcpSelectionOverride: false,
        permissionCeiling: 'acceptEdits',
      },
    });

    expect(parsed.sessionAgentSpawnPolicyV1).toMatchObject({
      allowCustomDirectory: false,
      allowEnvironmentVariables: false,
      allowMcpSelectionOverride: false,
      permissionCeiling: 'acceptEdits',
    });
    expect(parsed.sessionAgentSpawnPolicyV1.allowModelOverride).toBe(true);
    expect(parsed.sessionAgentSpawnPolicyV1.allowConnectedServicesOverride).toBe(true);
  });

  it('falls back to no session-agent spawn permission ceiling for invalid policy values', () => {
    const parsed = accountSettingsParse({
      sessionAgentSpawnPolicyV1: {
        v: 1,
        permissionCeiling: 'not-a-permission-mode',
      },
    });

    expect(parsed.sessionAgentSpawnPolicyV1.permissionCeiling).toBeNull();
  });

  it('migrates legacy default session-agent action settings to the current default-open matrix', () => {
    const legacyDefaultDisabled = [
      'session.stop',
      'session.title.set',
      'session.permission_mode.set',
      'session.model.set',
      'session.archive',
      'session.unarchive',
      'session.status.get',
      'session.history.get',
      'session.wait.idle',
      'session.message.send',
      'session.permission.respond',
      'session.user_action.answer',
      'session.mode.set',
      'session.list',
      'session.activity.get',
      'session.messages.recent.get',
    ] as const;

    const parsed = accountSettingsParse({
      actionsSettingsV1: {
        v: 1,
        actions: Object.fromEntries(
          legacyDefaultDisabled.map((id) => [id, { disabledSurfaces: ['session_agent'] }]),
        ),
      },
    });
    const settings = parsed.actionsSettingsV1;

    expect(isActionEnabledByActionsSettings('session.stop' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.title.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.message.send' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.permission_mode.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.model.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.archive' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
  });

  it('migrates legacy session-agent defaults without dropping unrelated action settings fields', () => {
    const legacyDefaultDisabled = [
      'session.stop',
      'session.title.set',
      'session.permission_mode.set',
      'session.model.set',
      'session.archive',
      'session.unarchive',
      'session.status.get',
      'session.history.get',
      'session.wait.idle',
      'session.message.send',
      'session.permission.respond',
      'session.user_action.answer',
      'session.mode.set',
      'session.list',
      'session.activity.get',
      'session.messages.recent.get',
    ] as const;

    const parsed = accountSettingsParse({
      actionsSettingsV1: {
        v: 1,
        actions: Object.fromEntries([
          ...legacyDefaultDisabled.map((id) => [id, { disabledSurfaces: ['session_agent'] }]),
          ['session.message.send', { disabledSurfaces: ['session_agent'], approvalRequiredSurfaces: ['cli'] }],
        ]),
      },
    });

    expect(isActionEnabledByActionsSettings('session.title.set' as any, parsed.actionsSettingsV1, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.message.send' as any, parsed.actionsSettingsV1, { surface: 'session_agent' } as any)).toBe(true);
    expect(parsed.actionsSettingsV1.actions['session.message.send' as any]?.approvalRequiredSurfaces).toEqual(['cli']);
  });
});
