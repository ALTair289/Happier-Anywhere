import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

vi.mock('@/persistence', () => ({
  readDaemonState: vi.fn(),
  writeDaemonStateIfLockOwned: vi.fn(),
}));

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFileSync } from 'fs';

import { readDaemonState, writeDaemonStateIfLockOwned } from '@/persistence';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { spawnSleepyDetachedProcess } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

describe('startDaemonHeartbeatLoop daemon self-restart', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir: string | null = null;

  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS;
    if (happyHomeDir && existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    happyHomeDir = null;
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not permanently lock the heartbeat loop if reading package.json throws', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: any[]) => any) => {
        tick = handler as unknown as () => Promise<void>;
        return 1 as any;
      }) as any);

    vi.mocked(readFileSync)
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockReturnValue(JSON.stringify({ version: '1.0.0' }) as any);

    vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(tick).toBeTypeOf('function');

    try {
      await tick!();
    } catch {
      // pre-fix behavior: first tick throws and leaves heartbeatRunning stuck true
    }

    await tick!();
    expect(spawnDetachedDaemonStartSync).not.toHaveBeenCalled();
  }, 15_000);

  it('uses start-sync and keeps the current daemon alive if replacement is not confirmed', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: any[]) => any) => {
        tick = handler as unknown as () => Promise<void>;
        return 1 as any;
      }) as any);

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '2.0.0' }) as any);
    vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    const interval = startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        runtimeId: 'runtime-heartbeat-restart',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(tick).toBeTypeOf('function');
    await tick!();

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        HAPPIER_DAEMON_RUNTIME_ID: 'runtime-heartbeat-restart',
        HAPPIER_DAEMON_TAKEOVER: '1',
      }),
      startupSource: 'self-restart',
    }));
    expect(exitSpy).not.toHaveBeenCalled();

    clearInterval(interval);
  }, 15_000);

  it('exits only after replacement daemon with current CLI version is confirmed', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '40';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';
    const replacement = spawnSleepyDetachedProcess();

    try {
      vi.resetModules();

      let tick: (() => Promise<void>) | undefined;
      const setIntervalSpy = vi
        .spyOn(global, 'setInterval')
        .mockImplementation(((handler: (...args: any[]) => any) => {
          tick = handler as unknown as () => Promise<void>;
          return 1 as any;
        }) as any);

      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '2.0.0' }) as any);
      let selfRestartCorrelationId = '';
      vi.mocked(spawnDetachedDaemonStartSync).mockImplementation(async (options) => {
        selfRestartCorrelationId = String(options?.env?.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID ?? '');
        return { unref: vi.fn() } as any;
      });
      vi.mocked(readDaemonState)
        .mockResolvedValueOnce({
          pid: process.pid,
          httpPort: 7001,
          startedAt: Date.now(),
          startedWithCliVersion: '1.0.0',
        })
        .mockResolvedValue({
          pid: replacement.pid,
          httpPort: 7002,
          startedAt: Date.now(),
          startedWithCliVersion: '2.0.0',
          runtimeId: 'runtime-heartbeat-confirmed',
          selfRestartCorrelationId,
          controlToken: 'replacement-control-token',
        })
        .mockImplementation(async () => ({
          pid: replacement.pid,
          httpPort: 7002,
          startedAt: Date.now(),
          startedWithCliVersion: '2.0.0',
          runtimeId: 'runtime-heartbeat-confirmed',
          selfRestartCorrelationId,
          controlToken: 'replacement-control-token',
        }));
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        if (
          url.hostname === '127.0.0.1'
          && url.port === '7002'
          && init?.method === 'POST'
          && (init.headers as Record<string, string> | undefined)?.['x-happier-daemon-token'] === 'replacement-control-token'
        ) {
          return new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: false }), { status: 401 });
      }));

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      const { startDaemonHeartbeatLoop } = await import('./heartbeat');

      const interval = startDaemonHeartbeatLoop({
        pidToTrackedSession: new Map(),
        spawnResourceCleanupByPid: new Map(),
        sessionAttachCleanupByPid: new Map(),
        getApiMachineForSessions: () => null,
        controlPort: 5555,
        fileState: {
          pid: process.pid,
          httpPort: 5555,
          startedAt: Date.now(),
          startedWithCliVersion: '1.0.0',
          runtimeId: 'runtime-heartbeat-confirmed',
        },
        currentCliVersion: '1.0.0',
        requestShutdown: vi.fn(),
      });

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(tick).toBeTypeOf('function');
      await tick!();

      expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
      expect(spawnDetachedDaemonStartSync).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.objectContaining({
          HAPPIER_DAEMON_RUNTIME_ID: 'runtime-heartbeat-confirmed',
          HAPPIER_DAEMON_TAKEOVER: '1',
        }),
        startupSource: 'self-restart',
      }));
      expect(exitSpy).toHaveBeenCalledWith(0);

      clearInterval(interval);
    } finally {
      await replacement.kill();
    }
  }, 15_000);

  it('preserves ownership metadata when writing heartbeat state updates', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-metadata-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';

    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      tick = handler as unknown as () => Promise<void>;
      return 1 as any;
    }) as any);

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.0.0' }) as any);
    vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      startedWithPublicReleaseChannel: 'preview',
      runtimeId: 'runtime-heartbeat',
      startupSource: 'background-service',
      serviceLabel: 'com.happier.cli.daemon.default',
      daemonLogPath: '/tmp/daemon.log',
      controlToken: 'token',
      lastHeartbeatAt: Date.now(),
    });

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'preview',
        runtimeId: 'runtime-heartbeat',
        startupSource: 'background-service',
        serviceLabel: 'com.happier.cli.daemon.default',
        daemonLogPath: '/tmp/daemon.log',
        controlToken: 'token',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(tick).toBeTypeOf('function');
    await tick!();

    expect(vi.mocked(writeDaemonStateIfLockOwned)).toHaveBeenCalledWith(expect.objectContaining({
      startedWithPublicReleaseChannel: 'preview',
      runtimeId: 'runtime-heartbeat',
      startupSource: 'background-service',
      serviceLabel: 'com.happier.cli.daemon.default',
    }));
  }, 15_000);

  it('requests shutdown without overwriting a successor daemon publication', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-successor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';

    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      tick = handler as unknown as () => Promise<void>;
      return 1 as any;
    }) as any);

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.0.0' }) as any);
    vi.mocked(readDaemonState).mockReset().mockResolvedValue({
      pid: process.pid + 1,
      httpPort: 9876,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      runtimeId: 'runtime-successor',
      controlToken: 'successor-control-token',
    });
    vi.mocked(writeDaemonStateIfLockOwned).mockClear();
    const requestShutdown = vi.fn();

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        runtimeId: 'runtime-retiring',
        controlToken: 'retiring-control-token',
      },
      currentCliVersion: '1.0.0',
      requestShutdown,
    });

    expect(tick).toBeTypeOf('function');
    await tick!();

    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(writeDaemonStateIfLockOwned).not.toHaveBeenCalled();
  }, 15_000);

  it('fails closed when a successor takes the lifecycle lock after ownership is read', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-lock-successor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';

    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      tick = handler as unknown as () => Promise<void>;
      return 1 as any;
    }) as any);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.0.0' }) as any);
    vi.mocked(readDaemonState).mockReset().mockResolvedValue({
      pid: process.pid,
      httpPort: 8765,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
    });
    vi.mocked(writeDaemonStateIfLockOwned).mockReset().mockReturnValue(false);
    const requestShutdown = vi.fn();

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
      },
      currentCliVersion: '1.0.0',
      requestShutdown,
    });

    expect(tick).toBeTypeOf('function');
    await tick!();

    expect(writeDaemonStateIfLockOwned).toHaveBeenCalledTimes(1);
    expect(writeDaemonStateIfLockOwned).toHaveReturnedWith(false);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledWith(
      'exception',
      'Daemon lifecycle lock ownership changed before heartbeat publication.',
    );
  }, 15_000);
});
