import { describe, expect, it, vi } from 'vitest';

import type { DaemonLocallyPersistedState } from '@/persistence';

function makeState(overrides: Partial<DaemonLocallyPersistedState> = {}): DaemonLocallyPersistedState {
  return {
    pid: process.pid + 100,
    httpPort: 5001,
    startedAt: Date.now(),
    startedWithCliVersion: '2.0.0',
    controlToken: 'control-token',
    ...overrides,
  };
}

describe('requestDaemonSelfRestart', () => {
  it('spawns a takeover replacement with the inherited runtime id and exits only after confirmation', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({ runtimeId: 'runtime-1' }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 25,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: { KEEP_ME: '1' },
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledWith(expect.objectContaining({
      startupSource: 'self-restart',
      env: expect.objectContaining({
        KEEP_ME: '1',
        HAPPIER_DAEMON_RUNTIME_ID: 'runtime-1',
        HAPPIER_DAEMON_TAKEOVER: '1',
      }),
    }));
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(result.status).toBe('exited');
  });

  it('overrides an inherited startup source in the replacement environment', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({ runtimeId: 'runtime-1' }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 25,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: { HAPPIER_DAEMON_STARTUP_SOURCE: 'manual' },
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledWith(expect.objectContaining({
      startupSource: 'self-restart',
      env: expect.objectContaining({
        HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
      }),
    }));
  });

  it('keeps the current daemon alive when the replacement is not confirmed', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({ pid: process.pid, startedWithCliVersion: '1.0.0' }));
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 5,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      exitProcess,
      env: {},
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    expect(exitProcess).not.toHaveBeenCalled();
    expect(result.status).toBe('replacement_not_confirmed');
  });

  it('does not exit for a different daemon runtime even when the CLI version matches', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({
      pid: process.pid + 100,
      startedWithCliVersion: '2.0.0',
      runtimeId: 'other-runtime',
    }));
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 5,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      exitProcess,
      env: {},
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    expect(exitProcess).not.toHaveBeenCalled();
    expect(result.status).toBe('replacement_not_confirmed');
  });

  it('can confirm a matching runtime replacement without requiring a predicted CLI version', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({
      startedWithCliVersion: '2.1.0',
      runtimeId: 'runtime-1',
    }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '',
      ownPid: process.pid,
      timeoutMs: 25,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: {},
    });

    expect(confirmReplacementState).toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(result.status).toBe('exited');
  });

  it('does not confirm a replacement from stale daemon state alone', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({
      pid: process.pid + 100,
      startedWithCliVersion: '2.0.0',
      runtimeId: 'runtime-1',
      httpPort: 51234,
      controlToken: 'stale-token',
    }));
    const confirmReplacementState = vi.fn(async () => false);
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 5,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: {},
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    expect(confirmReplacementState).toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expect(result.status).toBe('replacement_not_confirmed');
  });

  it('requires authenticated ping details before confirming a runtime-id replacement', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({
      pid: process.pid + 100,
      startedWithCliVersion: '2.0.0',
      runtimeId: 'runtime-1',
      controlToken: undefined,
    }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 5,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: {},
    });

    expect(confirmReplacementState).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expect(result.status).toBe('replacement_not_confirmed');
  });

  it('coalesces concurrent self-restart requests with one correlation id and one spawn', async () => {
    let resolveSpawn!: () => void;
    const spawnDetachedDaemonStartSync = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveSpawn = resolve;
      });
      return { unref: vi.fn() };
    });
    const readDaemonState = vi.fn(async () => makeState({ runtimeId: 'runtime-single-flight' }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const first = requestDaemonSelfRestart({
      runtimeId: 'runtime-single-flight',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 25,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: {},
    });
    const second = requestDaemonSelfRestart({
      runtimeId: 'runtime-single-flight',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 25,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: {},
    });

    await Promise.resolve();
    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    resolveSpawn!();

    await expect(Promise.all([first, second])).resolves.toEqual([{ status: 'exited' }, { status: 'exited' }]);
    const [firstSpawnOptions] = spawnDetachedDaemonStartSync.mock.calls[0] as unknown as [
      { env?: Record<string, string | undefined> },
    ];
    const env = firstSpawnOptions.env ?? {};
    expect(env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID).toMatch(/^self-restart-/);
    expect(exitProcess).toHaveBeenCalledTimes(1);
  });
});
