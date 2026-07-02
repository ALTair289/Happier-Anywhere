import { describe, expect, it } from 'vitest';

import {
  mergeSpawnSessionOptions,
  SpawnDaemonSessionRequestSchema,
} from './spawnSessionOptionsContract';
import type { SpawnSessionOptions } from './registerSessionHandlers';

describe('SpawnDaemonSessionRequestSchema', () => {
  it('accepts Windows terminal modes in the terminal payload', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'happier-qa',
    });

    expect(parsed.terminal?.mode).toBe('windows_terminal');
    expect(parsed.windowsRemoteSessionLaunchMode).toBe('windows_terminal');
    expect(parsed.windowsTerminalWindowName).toBe('happier-qa');
  });

  it('maps legacy experimentalCodexAcp requests onto canonical codexBackendMode', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: true,
    });

    expect(parsed.codexBackendMode).toBe('acp');
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('drops legacy experimentalCodexAcp when false', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: false,
    });

    expect(parsed.codexBackendMode).toBeUndefined();
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('preserves canonical codex backend mode from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      codexBackendMode: 'appServer',
    });

    expect(parsed.codexBackendMode).toBe('appServer');
  });

  it('accepts attach metadata identity policy from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
    });

    expect(parsed.attachMetadataIdentityPolicy).toBe('replace_with_runtime_identity');
  });

  it('accepts account settings version hints from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      accountSettingsVersionHint: 42,
    });

    expect(parsed.accountSettingsVersionHint).toBe(42);
  });

  it('accepts connected-services binding timestamps from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      connectedServices: { v: 1, bindingsByServiceId: {} },
      connectedServicesUpdatedAt: 123,
    });

    expect(parsed.connectedServicesUpdatedAt).toBe(123);
  });

  it('accepts approved directory creation through the internal transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      approvedNewDirectoryCreation: true,
    });

    expect(parsed.approvedNewDirectoryCreation).toBe(true);
  });

  it('accepts initial transcript catch-up cursors from resume requests', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      initialTranscriptAfterSeq: 36,
    });

    expect(parsed.initialTranscriptAfterSeq).toBe(36);
  });

  it('accepts multiline initial goal controls from resume requests', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      initialGoal: {
        objective: 'Line one\nLine two',
      },
    });

    expect(parsed.initialGoal).toEqual({
      objective: 'Line one\nLine two',
    });
  });

  it('rejects malformed account settings version hints', () => {
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      accountSettingsVersionHint: -1,
    })).toThrow();

    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      accountSettingsVersionHint: 1.5,
    })).toThrow();
  });

  it('preserves account settings version hints through spawn option merging', () => {
    const options = {
      directory: '/tmp',
      accountSettingsVersionHint: 7,
    } as Partial<SpawnSessionOptions>;

    expect(mergeSpawnSessionOptions(options)).toMatchObject({
      accountSettingsVersionHint: 7,
    });
  });

  it('preserves connected-services binding timestamps through spawn option merging', () => {
    const options = {
      directory: '/tmp',
      connectedServices: { v: 1, bindingsByServiceId: {} },
      connectedServicesUpdatedAt: 456,
    } as Partial<SpawnSessionOptions>;

    expect(mergeSpawnSessionOptions(options)).toMatchObject({
      connectedServicesUpdatedAt: 456,
    });
  });

  it('preserves materialization diagnostics through spawn option merging', () => {
    const options = {
      directory: '/tmp',
      materializationDiagnostics: [{
        code: 'state_sharing_degraded',
        providerId: 'claude',
        serviceId: 'anthropic',
        requestedStateMode: 'shared',
        effectiveStateMode: 'isolated',
        reason: 'provider_state_unavailable',
      }],
    } as Partial<SpawnSessionOptions>;

    expect(mergeSpawnSessionOptions(options)).toMatchObject({
      materializationDiagnostics: options.materializationDiagnostics,
    });
  });
});
