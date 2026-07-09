import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProcessAlive, terminateProcessTreeByPid } from '../process/processTree';

const cliLaunchSpecMock = vi.hoisted(() => ({
  resolveCliTestLaunchSpec: vi.fn(),
}));

vi.mock('../process/cliLaunchSpec', async () => {
  const actual = await vi.importActual<typeof import('../process/cliLaunchSpec')>('../process/cliLaunchSpec');
  return {
    ...actual,
    resolveCliTestLaunchSpec: cliLaunchSpecMock.resolveCliTestLaunchSpec,
  };
});

import {
  replaceTestDaemonWithoutStoppingSessions,
  resolveTestDaemonOwnershipLeasesDir,
  sanitizeDaemonEnvForSpawn,
  startTestDaemon,
} from './daemon';
import { repoRootDir } from '../paths';
import { spawnDetachedTestProcess } from '../process/testSpawn';
import { seedCliAuthForServer } from '../cliAuth';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function writeHoldingDaemonScript(scriptPath: string, opts: { writesState: boolean; httpPort?: number }): Promise<void> {
  const contents = [
    "import { writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const homeDir = process.env.HAPPIER_HOME_DIR;",
    "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
    opts.writesState
      ? `writeFileSync(resolve(homeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: ${opts.httpPort ?? 32_222}, controlToken: 'fresh-control-token' }), 'utf8');`
      : '',
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1_000);",
  ]
    .filter(Boolean)
    .join('\n');

  await writeFile(scriptPath, contents, 'utf8');
}

async function writeExitAfterStateDaemonScript(scriptPath: string, opts: { homeDir: string; serverId: string; httpPort: number }): Promise<void> {
  const contents = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const homeDir = process.env.HAPPIER_HOME_DIR;",
    "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
    `const stateDir = resolve(homeDir, 'servers', ${JSON.stringify(opts.serverId)});`,
    "mkdirSync(stateDir, { recursive: true });",
    `writeFileSync(resolve(stateDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: ${opts.httpPort}, controlToken: 'fresh-control-token' }), 'utf8');`,
    "process.exit(1);",
  ].join('\n');

  await writeFile(scriptPath, contents, 'utf8');
}

async function writeReplacementDaemonScript(scriptPath: string, opts: { serverId: string; httpPort: number; stateWriteDelayMs?: number }): Promise<void> {
  const contents = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const homeDir = process.env.HAPPIER_HOME_DIR;",
    "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
    "const args = process.argv.slice(2).join(' ');",
    "if (args !== 'daemon start-sync --takeover') process.exit(7);",
    opts.stateWriteDelayMs ? `await new Promise((resolve) => setTimeout(resolve, ${opts.stateWriteDelayMs}));` : '',
    `const stateDir = resolve(homeDir, 'servers', ${JSON.stringify(opts.serverId)});`,
    "mkdirSync(stateDir, { recursive: true });",
    `writeFileSync(resolve(stateDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: ${opts.httpPort}, controlToken: 'replacement-control-token' }), 'utf8');`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1_000);",
  ].join('\n');

  await writeFile(scriptPath, contents, 'utf8');
}

describe('startTestDaemon', () => {
  it('forces source subprocesses for source-entrypoint daemon tests', () => {
    expect(sanitizeDaemonEnvForSpawn({
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: undefined,
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/stack/cli/dist/index.mjs',
    })).toMatchObject({
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1',
    });
  });

  it('defaults source-entrypoint daemon snapshots to copy-mode node_modules when unset', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-source-snapshot-copy-default-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(fakeScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_228 });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(fakeScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        },
        startupTimeoutMs: 15_000,
      });

      const launchCall = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls.at(0)?.[0] as
        | { env?: NodeJS.ProcessEnv }
        | undefined;
      expect(launchCall?.env?.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE).toBe('copy');
      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls.at(0)?.[1] as
        | { snapshotDir?: string }
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(resolve(repoRootDir(), '.project', 'tmp', 'cli-source-snapshot'));

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('respects explicit source-entrypoint node_modules snapshot mode overrides', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-source-snapshot-copy-explicit-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(fakeScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_229 });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(fakeScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
        },
        startupTimeoutMs: 15_000,
      });

      const launchCall = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls.at(0)?.[0] as
        | { env?: NodeJS.ProcessEnv }
        | undefined;
      expect(launchCall?.env?.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE).toBe('symlink');

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('fails with phase diagnostics when daemon startup stalls before spawning the daemon', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-startup-phase-timeout-'));
    const homeDir = resolve(testDir, 'home');

    try {
      await mkdir(homeDir, { recursive: true });
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockImplementationOnce(async () => {
        await new Promise(() => {});
        throw new Error('unreachable');
      });

      const result = await Promise.race([
        startTestDaemon({
          testDir,
          happyHomeDir: homeDir,
          env: {},
          startupTimeoutMs: 25,
        }).then(
          () => 'started',
          (error: unknown) => error,
        ),
        new Promise<'still-pending'>((resolvePending) => setTimeout(() => resolvePending('still-pending'), 1_000)),
      ]);

      expect(result).toBeInstanceOf(Error);
      expect(String((result as Error).message)).toContain('phase=resolveCliTestLaunchSpec');
      expect(String((result as Error).message)).toContain(`testDir=${testDir}`);
      expect(String((result as Error).message)).toContain(`happyHomeDir=${homeDir}`);
      expect(String((result as Error).message)).toContain(resolve(testDir, 'daemon.stdout.log'));
      expect(String((result as Error).message)).toContain(resolve(testDir, 'daemon.stderr.log'));
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('lets launch-spec resolution use the cli dist build timeout by default', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-launch-spec-build-budget-'));
    const homeDir = resolve(testDir, 'home');
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | null = null;

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(fakeScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_230 });

      vi.useFakeTimers();

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockImplementationOnce(async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 400_000));
        return {
          command: process.execPath,
          args: [resolve(fakeScriptDir, 'index.mjs')],
          cwd: testDir,
          env: {},
        };
      });

      const pendingDaemon = startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {},
      });

      for (let attempt = 0; attempt < 100 && cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls.length === 0; attempt += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledTimes(1);

      let settled: unknown = 'pending';
      pendingDaemon.then(
        (value) => {
          settled = value;
        },
        (error: unknown) => {
          settled = error;
        },
      );

      await vi.advanceTimersByTimeAsync(300_001);
      expect(settled).toBe('pending');

      await vi.advanceTimersByTimeAsync(100_000);
      vi.useRealTimers();

      daemon = await pendingDaemon;
      expect(daemon.state.httpPort).toBe(32_230);
    } finally {
      vi.useRealTimers();
      if (daemon) await daemon.stop();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('reclaims a stale daemon ownership lease from a dead worker before starting a fresh daemon', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-lease-preflight-'));
    const homeDir = resolve(testDir, 'home');
    let stalePid: number | null = null;
    let freshPid: number | null = null;

    try {
      const freshScriptDir = resolve(testDir, 'fresh-daemon', 'dist');
      await mkdir(freshScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(freshScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_224 });

      const staleProc = spawnDetachedTestProcess(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);", 'daemon', 'start-sync'], {
        stdio: 'ignore',
      });
      stalePid = staleProc.pid ?? null;
      expect(typeof stalePid).toBe('number');
      expect(stalePid && stalePid > 1).toBe(true);

      const startTimeRes = spawnSync('ps', ['-o', 'lstart=', '-p', String(stalePid), '-ww'], { encoding: 'utf8' });
      expect(startTimeRes.status).toBe(0);

      const leaseDir = resolveTestDaemonOwnershipLeasesDir();
      await mkdir(leaseDir, { recursive: true });
      await writeFile(
        resolve(leaseDir, `pid-${stalePid}.json`),
        JSON.stringify({
          childPid: stalePid,
          childStartTime: String(startTimeRes.stdout ?? '').trim(),
          ownerPid: 999999001,
          ownerStartTime: 'Tue Mar 18 09:09:09 2026',
          createdAtMs: Date.now(),
          metadata: { happyHomeDir: homeDir },
        }),
        'utf8',
      );

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(freshScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {
          HAPPIER_FAKE_DAEMON_HTTP_PORT: '32_224',
        },
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        startupTimeoutMs: 15_000,
      });

      freshPid = daemon.proc.child.pid ?? null;
      expect(typeof freshPid).toBe('number');
      expect(freshPid && freshPid > 1).toBe(true);
      expect(freshPid).not.toBe(stalePid);
      expect(isProcessAlive(stalePid!)).toBe(false);

      await daemon.stop();
    } finally {
      if (freshPid) await terminateProcessTreeByPid(freshPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (stalePid) await terminateProcessTreeByPid(stalePid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('reclaims a stale daemon before starting a fresh one for the same home dir', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-preflight-'));
    const homeDir = resolve(testDir, 'home');
    let stalePid: number | null = null;
    let freshPid: number | null = null;

    try {
      const staleScriptDir = resolve(testDir, 'stale-daemon', 'dist');
      const freshScriptDir = resolve(testDir, 'fresh-daemon', 'dist');
      await mkdir(staleScriptDir, { recursive: true });
      await mkdir(freshScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(staleScriptDir, 'index.mjs'), { writesState: false });
      await writeHoldingDaemonScript(resolve(freshScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_223 });

      const staleProc = spawnDetachedTestProcess(process.execPath, [resolve(staleScriptDir, 'index.mjs'), 'daemon', 'start-sync'], {
        stdio: 'ignore',
      });
      stalePid = staleProc.pid ?? null;
      expect(typeof stalePid).toBe('number');
      expect(stalePid && stalePid > 1).toBe(true);

      await writeFile(
        resolve(homeDir, 'daemon.state.json'),
        JSON.stringify({
          pid: stalePid,
          httpPort: 0,
          controlToken: 'stale-control-token',
        }),
        'utf8',
      );

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(freshScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {
          HAPPIER_FAKE_DAEMON_HTTP_PORT: '32_223',
        },
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        startupTimeoutMs: 15_000,
      });

      freshPid = daemon.proc.child.pid ?? null;
      expect(typeof freshPid).toBe('number');
      expect(freshPid && freshPid > 1).toBe(true);
      expect(daemon.state.pid).toBe(freshPid);
      expect(freshPid).not.toBe(stalePid);

      expect(isProcessAlive(stalePid!)).toBe(false);

      await daemon.stop();
    } finally {
      if (freshPid) await terminateProcessTreeByPid(freshPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (stalePid) await terminateProcessTreeByPid(stalePid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('returns daemon state even if the daemon exits after persisting daemon.state.json', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-exit-after-state-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      const { serverId } = await seedCliAuthForServer({
        cliHome: homeDir,
        serverUrl: 'http://127.0.0.1:31111',
        token: 'token-for-start-test-daemon',
        secret: Uint8Array.from(randomBytes(32)),
      });

      await writeExitAfterStateDaemonScript(resolve(fakeScriptDir, 'index.mjs'), {
        homeDir,
        serverId,
        httpPort: 32_225,
      });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(fakeScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        startupTimeoutMs: 15_000,
      });

      expect(daemon.state.httpPort).toBe(32_225);
      expect(daemon.state.pid).toBe(daemon.proc.child.pid);
      expect(daemon.proc.child.exitCode).toBe(1);

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('starts replacement daemons through start-sync takeover and reads active-server daemon state', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-replacement-'));
    const homeDir = resolve(testDir, 'home');
    let originalPid: number | null = null;
    let replacementPid: number | null = null;

    try {
      const originalScriptDir = resolve(testDir, 'original-daemon', 'dist');
      const replacementScriptDir = resolve(testDir, 'replacement-daemon', 'dist');
      await mkdir(originalScriptDir, { recursive: true });
      await mkdir(replacementScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      const { serverId } = await seedCliAuthForServer({
        cliHome: homeDir,
        serverUrl: 'http://127.0.0.1:31112',
        token: 'token-for-replace-test-daemon',
        secret: Uint8Array.from(randomBytes(32)),
      });

      await writeHoldingDaemonScript(resolve(originalScriptDir, 'index.mjs'), {
        writesState: false,
        httpPort: 32_226,
      });

      const original = spawnDetachedTestProcess(process.execPath, [
        resolve(originalScriptDir, 'index.mjs'),
        'daemon',
        'start-sync',
      ], {
        stdio: 'ignore',
      });
      originalPid = original.pid ?? null;
      expect(typeof originalPid).toBe('number');
      expect(originalPid && originalPid > 1).toBe(true);

      await writeFile(
        resolve(homeDir, 'daemon.state.json'),
        JSON.stringify({
          pid: originalPid,
          httpPort: 32_226,
          controlToken: 'original-control-token',
        }),
        'utf8',
      );

      await writeReplacementDaemonScript(resolve(replacementScriptDir, 'index.mjs'), {
        serverId,
        httpPort: 32_227,
        stateWriteDelayMs: 500,
      });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(replacementScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const state = await replaceTestDaemonWithoutStoppingSessions({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        stdoutPath: resolve(testDir, 'replacement.stdout.log'),
        stderrPath: resolve(testDir, 'replacement.stderr.log'),
      });

      replacementPid = state.pid;
      expect(state).toEqual(expect.objectContaining({
        httpPort: 32_227,
        controlToken: 'replacement-control-token',
      }));
      expect(replacementPid).not.toBe(originalPid);
      expect(isProcessAlive(originalPid!)).toBe(false);
      expect(isProcessAlive(replacementPid)).toBe(true);
    } finally {
      if (replacementPid) await terminateProcessTreeByPid(replacementPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (originalPid) await terminateProcessTreeByPid(originalPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('refuses to replace a daemon when daemon.state.json points to a non-daemon process', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-replacement-safety-'));
    const homeDir = resolve(testDir, 'home');
    let originalPid: number | null = null;

    try {
      await mkdir(homeDir, { recursive: true });

      const original = spawnDetachedTestProcess(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
      ], {
        stdio: 'ignore',
      });
      originalPid = original.pid ?? null;
      expect(typeof originalPid).toBe('number');
      expect(originalPid && originalPid > 1).toBe(true);

      await writeFile(
        resolve(homeDir, 'daemon.state.json'),
        JSON.stringify({
          pid: originalPid,
          httpPort: 32_228,
          controlToken: 'original-control-token',
        }),
        'utf8',
      );

      await expect(
        replaceTestDaemonWithoutStoppingSessions({
          testDir,
          happyHomeDir: homeDir,
          env: {},
        }),
      ).rejects.toThrow('refusing to hard-kill');

      expect(isProcessAlive(originalPid!)).toBe(true);
    } finally {
      if (originalPid) await terminateProcessTreeByPid(originalPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  }, 20_000);
});
