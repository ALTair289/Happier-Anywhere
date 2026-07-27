import { describe, expect, it } from 'vitest';

import { buildClaudeAgentState } from './buildClaudeAgentState';

describe('buildClaudeAgentState', () => {
  it('does not advertise user-message handler readiness until explicitly ready', () => {
    expect(buildClaudeAgentState({
      currentState: {},
      mode: 'remote',
      claudeUnifiedTerminalEnabled: false,
      localPermissionBridgeEnabled: false,
    }).capabilities).toMatchObject({
      userMessageHandlerReady: false,
    });
  });

  it('publishes unified terminal sessions as shared and remote-writable instead of locally controlled', () => {
    expect(buildClaudeAgentState({
      currentState: {
        capabilities: {
          inFlightSteer: true,
        },
      },
      mode: 'remote',
      claudeUnifiedTerminalEnabled: true,
      localPermissionBridgeEnabled: true,
      userMessageHandlerReady: true,
    })).toMatchObject({
      controlledByUser: false,
      localControl: {
        attached: true,
        topology: 'shared',
        remoteWritable: true,
        canAttach: true,
        canDetach: false,
      },
      capabilities: {
        inFlightSteer: true,
        inFlightSteerSupported: true,
        inFlightSteerAvailable: true,
        askUserQuestionAnswersInPermission: true,
        localPermissionBridgeInLocalMode: true,
        permissionsInUiWhileLocal: true,
        userMessageHandlerReady: true,
      },
    });
  });

  it('publishes inFlightConfigApplySupported for unified sessions with TUI runtime control (lane Q)', () => {
    const withControl = buildClaudeAgentState({
      currentState: {},
      mode: 'remote',
      claudeUnifiedTerminalEnabled: true,
      localPermissionBridgeEnabled: false,
      tuiRuntimeControlEnabled: true,
      userMessageHandlerReady: true,
    });
    expect(withControl.capabilities).toMatchObject({ inFlightConfigApplySupported: true });

    const withoutControl = buildClaudeAgentState({
      currentState: {},
      mode: 'remote',
      claudeUnifiedTerminalEnabled: true,
      localPermissionBridgeEnabled: false,
      tuiRuntimeControlEnabled: false,
      userMessageHandlerReady: true,
    });
    expect((withoutControl.capabilities as Record<string, unknown>).inFlightConfigApplySupported).toBeUndefined();

    const legacy = buildClaudeAgentState({
      currentState: {},
      mode: 'local',
      claudeUnifiedTerminalEnabled: false,
      localPermissionBridgeEnabled: false,
      tuiRuntimeControlEnabled: true,
    });
    expect((legacy.capabilities as Record<string, unknown>).inFlightConfigApplySupported).toBeUndefined();
  });

  it('preserves legacy Claude local-control semantics when unified terminal is disabled', () => {
    expect(buildClaudeAgentState({
      currentState: {
        localControl: {
          attached: true,
          topology: 'shared',
          remoteWritable: true,
        },
      },
      mode: 'local',
      claudeUnifiedTerminalEnabled: false,
      localPermissionBridgeEnabled: false,
    })).toMatchObject({
      controlledByUser: true,
      localControl: null,
      capabilities: {
        askUserQuestionAnswersInPermission: true,
        localPermissionBridgeInLocalMode: false,
        permissionsInUiWhileLocal: false,
      },
    });
  });
});
