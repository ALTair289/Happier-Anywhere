import { describe, expect, it } from 'vitest';

import {
  CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
  CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  connectedServiceProfileKey,
  isAgentStateRequestCoveredByCompletedRequests,
  getAgentMediaCapabilities,
  isClaudeLocalPermissionBridgeAgentStateRequest,
  isClaudeUnifiedTerminalDialogChoiceAgentStateRequest,
  KIMI_PROVIDER_FIELDS,
  resolveConnectedServiceDefaultProfileId,
  resolveConnectedServiceProfileLabel,
} from './index.js';
import {
  CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE as CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX,
  CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON as CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON_FROM_CLAUDE_INDEX,
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE as CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE_FROM_CLAUDE_INDEX,
  isClaudeLocalPermissionBridgeAgentStateRequest as isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex,
  isClaudeUnifiedTerminalDialogChoiceAgentStateRequest as isClaudeUnifiedTerminalDialogChoiceAgentStateRequestFromClaudeIndex,
} from './providers/claude/index.js';

describe('agents package exports', () => {
  it('re-exports the Claude local permission bridge helper from the package root', () => {
    expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE).toBe('claude_local_permission_bridge');
    expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON).toBe('Local permission bridge stopped');
    expect(isClaudeLocalPermissionBridgeAgentStateRequest({ source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE })).toBe(true);
    expect(isClaudeLocalPermissionBridgeAgentStateRequest({ source: 'other' })).toBe(false);
  });

  it('re-exports the Claude unified terminal dialog-choice request helper from the package root', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE).toBe('claude_unified_terminal_dialog_choice');
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest({
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
    })).toBe(true);
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest({
      source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    })).toBe(false);
  });

  it('re-exports the Claude local permission bridge helper from the Claude provider entrypoint', () => {
    expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX).toBe('claude_local_permission_bridge');
    expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON_FROM_CLAUDE_INDEX).toBe('Local permission bridge stopped');
    expect(isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex({
      source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX,
    })).toBe(true);
    expect(isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex({ source: 'other' })).toBe(false);
  });

  it('re-exports the agent-state request coverage helper from the package root', () => {
    expect(isAgentStateRequestCoveredByCompletedRequests({
      requestId: 'req',
      request: { tool: 'Write', arguments: { file_path: '/tmp/a' }, createdAt: 1 },
      completedRequests: { req: { tool: 'Write', arguments: { file_path: '/tmp/a' }, completedAt: 2 } },
    })).toBe(true);
  });

  it('re-exports the Claude unified terminal dialog-choice request helper from the Claude provider entrypoint', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE_FROM_CLAUDE_INDEX)
      .toBe('claude_unified_terminal_dialog_choice');
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequestFromClaudeIndex({
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE_FROM_CLAUDE_INDEX,
    })).toBe(true);
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequestFromClaudeIndex({ source: 'other' })).toBe(false);
  });

  it('re-exports provider media capability helpers from the package root', () => {
    expect(getAgentMediaCapabilities('codex').nativeImageGeneration).toBe('supported');
  });

  it('re-exports Kimi provider setting fields from the package root', () => {
    expect(KIMI_PROVIDER_FIELDS.kimiAcpPythonSelector.default).toBe('auto');
  });

  it('re-exports connected-service session option helpers from the package root', () => {
    expect(connectedServiceProfileKey({ serviceId: 'anthropic', profileId: 'work/team' })).toBe(
      'anthropic/work%2Fteam',
    );
    expect(resolveConnectedServiceProfileLabel({
      labelsByKey: { 'anthropic/work%2Fteam': ' Work Team ' },
      serviceId: 'anthropic',
      profileId: 'work/team',
    })).toBe('Work Team');
    expect(resolveConnectedServiceDefaultProfileId({
      serviceId: 'anthropic',
      connectedProfileIds: ['personal', 'work'],
      defaultProfileByServiceId: { anthropic: 'work' },
    })).toBe('work');
  });

  it('re-exports Claude Code OAuth scope constants from the package root', async () => {
    const mod = await import('./index.js');

    expect(mod.CLAUDE_CODE_REQUIRED_OAUTH_SCOPES).toEqual([
      'user:inference',
      'user:profile',
      'user:sessions:claude_code',
    ]);
    expect(mod.CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES).toEqual([
      'user:inference',
      'user:profile',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ]);
    expect(mod.CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE).toBe([
      'user:inference',
      'user:profile',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ].join(' '));
  });
});
