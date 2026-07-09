import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const { loggerInfoMock, loggerWarnMock, loggerDebugMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: loggerDebugMock,
  },
}));

import {
  ExecutionRunConnectedServicesUnavailableError,
  prepareExecutionRunConnectedServices,
} from './prepareExecutionRunConnectedServices';

const CREDENTIALS = { token: 'cred-1' } as unknown as Credentials;

const TEAM_DEFAULT_BINDINGS = {
  v: 1 as const,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'team' },
    'openai': { source: 'native' as const },
  },
};

describe('prepareExecutionRunConnectedServices', () => {
  it('QA2-F02: an account default resolves through the SESSION spawn-default owner (not a runner settings snapshot) and materializes', async () => {
    const materialize = vi.fn(async (_input: unknown) => ({ env: { CODEX_HOME: '/run/root/codex/codex-home' } }));
    const release = vi.fn(async (_input: unknown) => true);
    // The session owner (blocking settings bootstrap) resolves the default — prepare must consume IT,
    // not any in-process settings snapshot (the live G5 failure: stale snapshot => silent native run).
    const resolveSessionSpawnDefaults = vi.fn(async (_input: unknown) => ({
      connectedServices: TEAM_DEFAULT_BINDINGS,
      connectedServicesUpdatedAt: Date.now(),
    }));

    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: release,
      resolveSessionSpawnDefaults,
    });

    expect(resolveSessionSpawnDefaults).toHaveBeenCalledTimes(1);
    expect(resolveSessionSpawnDefaults.mock.calls.at(0)?.[0]).toMatchObject({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
    });
    expect(prepared).not.toBeNull();
    expect(prepared?.env).toEqual({ CODEX_HOME: '/run/root/codex/codex-home' });

    const materializeInput = materialize.mock.calls.at(0)?.[0] as Record<string, unknown>;
    expect(materializeInput).toMatchObject({
      agentId: 'codex',
      pid: process.pid,
      sessionDirectory: '/tmp/workspace',
      sessionId: 'session-1',
      connectedServicesBindingsRaw: TEAM_DEFAULT_BINDINGS,
    });
    expect(String(materializeInput.materializationKey)).toMatch(/^execution_run:/u);

    await prepared?.cleanup();
    expect(release).toHaveBeenCalledTimes(1);

    // Cleanup is idempotent.
    await prepared?.cleanup();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('an explicit per-target selection overrides the session default entirely', async () => {
    const materialize = vi.fn(async (_input: unknown) => ({ env: { CODEX_HOME: '/run/root/codex/codex-home' } }));
    const resolveSessionSpawnDefaults = vi.fn(async (_input: unknown) => ({
      connectedServices: TEAM_DEFAULT_BINDINGS,
      connectedServicesUpdatedAt: Date.now(),
    }));

    const explicit = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    };
    await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: explicit,
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults,
    });

    expect(resolveSessionSpawnDefaults).not.toHaveBeenCalled();
    expect(materialize.mock.calls.at(0)?.[0]).toMatchObject({
      connectedServicesBindingsRaw: explicit,
    });
  });

  it('QA2-F03: logs one info line when no selection resolves and proceeds native (no bridge call)', async () => {
    loggerInfoMock.mockClear();
    const materialize = vi.fn(async (_input: unknown) => ({ env: {} }));
    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => null),
    });
    expect(prepared).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
    const nativeLog = loggerInfoMock.mock.calls.find(([message]) => String(message).includes('proceeding native'));
    expect(nativeLog).toBeDefined();
  });

  it('QA2-F03: logs one info line on successful materialization (env key NAMES only, never values)', async () => {
    loggerInfoMock.mockClear();
    await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (_input: unknown) => ({ env: { CODEX_HOME: '/run/root/codex/codex-home' } })),
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
        connectedServices: TEAM_DEFAULT_BINDINGS,
        connectedServicesUpdatedAt: Date.now(),
      })),
    });
    const materializedLog = loggerInfoMock.mock.calls.find(([message]) => String(message).includes('materialized'));
    expect(materializedLog).toBeDefined();
    expect(JSON.stringify(materializedLog)).toContain('CODEX_HOME');
    expect(JSON.stringify(materializedLog)).not.toContain('/run/root/codex/codex-home');
  });

  it('returns null for non-builtInAgent targets without touching the default owner', async () => {
    const materialize = vi.fn(async (_input: unknown) => ({ env: {} }));
    const resolveSessionSpawnDefaults = vi.fn(async (_input: unknown) => null);
    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults,
    });
    expect(prepared).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
    expect(resolveSessionSpawnDefaults).not.toHaveBeenCalled();
  });

  it('proceeds native (logged) when credentials are unavailable for default resolution', async () => {
    loggerInfoMock.mockClear();
    const resolveSessionSpawnDefaults = vi.fn(async (_input: unknown) => null);
    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: null,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (_input: unknown) => ({ env: {} })),
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults,
    });
    expect(prepared).toBeNull();
    expect(resolveSessionSpawnDefaults).not.toHaveBeenCalled();
    expect(loggerInfoMock.mock.calls.some(([message]) => String(message).includes('proceeding native'))).toBe(true);
  });

  it('fails CLOSED with a typed error (and a warn log) when a selection exists but the bridge fails', async () => {
    loggerWarnMock.mockClear();
    const materialize = vi.fn(async (_input: unknown) => {
      throw new Error('daemon unreachable');
    });
    await expect(prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
        connectedServices: TEAM_DEFAULT_BINDINGS,
        connectedServicesUpdatedAt: Date.now(),
      })),
    })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(loggerWarnMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('A1: releases best-effort on the FAILURE path so a daemon-side success after client timeout is reclaimed', async () => {
    // The client can abandon the call (transport timeout) while the daemon still completes the
    // materialization + registration. The failure path must fire the idempotent release (keyed by the
    // materialization key prepare already knows) so that late daemon-side success is always reclaimed.
    const release = vi.fn(async (_input: unknown) => true);
    const materialize = vi.fn(async (_input: unknown) => {
      throw new Error('Request failed: materialize, The operation was aborted due to timeout');
    });

    await expect(prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: release,
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
        connectedServices: TEAM_DEFAULT_BINDINGS,
        connectedServicesUpdatedAt: Date.now(),
      })),
    })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);

    expect(release).toHaveBeenCalledTimes(1);
    const releaseInput = release.mock.calls.at(0)?.[0] as Record<string, unknown>;
    expect(String(releaseInput.materializationKey)).toMatch(/^execution_run:/u);
    expect(releaseInput.pid).toBe(process.pid);
    // The materialize call and the reclaim release use the SAME run key.
    const materializeInput = materialize.mock.calls.at(0)?.[0] as Record<string, unknown>;
    expect(releaseInput.materializationKey).toBe(materializeInput.materializationKey);
  });

  it('releases the daemon-side state and proceeds native when the bridge returns an empty env', async () => {
    const release = vi.fn(async (_input: unknown) => true);
    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (_input: unknown) => ({ env: {} })),
      releaseViaDaemon: release,
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
        connectedServices: TEAM_DEFAULT_BINDINGS,
        connectedServicesUpdatedAt: Date.now(),
      })),
    });
    expect(prepared).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
