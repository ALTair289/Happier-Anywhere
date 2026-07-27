import { describe, expect, it } from 'vitest';

import { buildHappySessionControlArgs } from './sessionSpawnArgs';

describe('buildHappySessionControlArgs', () => {
  it('preserves exact nonblank opaque mode and model identifiers', () => {
    expect(buildHappySessionControlArgs({
      agentModeId: ' plan ',
      agentModeUpdatedAt: 123,
      modelId: ' model-a ',
      modelUpdatedAt: 456,
    })).toEqual([
      '--agent-mode', ' plan ', '--agent-mode-updated-at', '123',
      '--model', ' model-a ', '--model-updated-at', '456',
    ]);
  });

  it('includes permission mode flags when provided', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
    })).toEqual(['--permission-mode', 'safe-yolo', '--permission-mode-updated-at', '123']);
  });

  it('includes model flags when provided', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: 456,
    })).toEqual(['--model', 'o3', '--model-updated-at', '456']);
  });

  it('includes agent mode flags when provided', () => {
    expect(buildHappySessionControlArgs({
      agentModeId: 'plan',
    })).toEqual(['--agent-mode', 'plan']);
  });

  it('omits model flags when modelUpdatedAt is missing', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: undefined,
    })).toEqual([]);
  });

  it('omits model flags when modelId is empty', () => {
    expect(buildHappySessionControlArgs({
      modelId: '   ',
      modelUpdatedAt: 456,
    })).toEqual([]);
  });

  it('includes resume and existing-session flags when values are present', () => {
    expect(buildHappySessionControlArgs({
      resume: '  resume-id  ',
      existingSessionId: ' existing-session-id ',
    })).toEqual(['--resume', 'resume-id', '--existing-session', 'existing-session-id']);
  });

  it('includes permission mode without timestamp when updatedAt is absent', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe',
    })).toEqual(['--permission-mode', 'safe']);
  });

  it('normalizes yolo to a Claude-compatible permission token for built-in Claude sessions', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
    })).toEqual(['--permission-mode', 'bypassPermissions', '--permission-mode-updated-at', '123']);
  });

  it('keeps safe-yolo as the Happier intent for built-in Claude child sessions', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'safe-yolo',
    })).toEqual(['--permission-mode', 'safe-yolo']);
  });

  it('supports model timestamp boundary value zero', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: 0,
    })).toEqual(['--model', 'o3', '--model-updated-at', '0']);
  });

  it('does not pass account settings version hints to child sessions', () => {
    const obsoleteOptions: Parameters<typeof buildHappySessionControlArgs>[0] & { accountSettingsVersionHint: number } = {
      accountSettingsVersionHint: 14,
    };
    expect(buildHappySessionControlArgs(obsoleteOptions)).toEqual([]);
  });

  it('includes backend flag when the backend target is a configured ACP backend', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: { kind: 'configuredAcpBackend', backendId: ' custom-kiro ' },
    })).toEqual(['--backend', 'custom-kiro']);
  });

});
