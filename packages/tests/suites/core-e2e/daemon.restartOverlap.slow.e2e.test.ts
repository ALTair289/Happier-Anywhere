import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import {
  readDaemonState,
  startTestDaemon,
  stopDaemonFromHomeDir,
  type DaemonState,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { assertPidAlive, readFakeClaudeSdkInvocationCount, readFakeClaudeSessionId } from '../../src/testkit/providers/fakeClaudeContinuity';
import { enqueueSessionPromptForScenario, waitForAssistantMessageContaining } from '../../src/testkit/providers/scenarios/sessionRuntime';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { countDuplicateLocalIds, fetchAllMessages, maxMessageSeq } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const TEST_TIMEOUT_MS = 300_000;

type ListedDaemonSession = Readonly<{
  happySessionId: string;
  pid: number;
  startedBy: string;
}>;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseListedDaemonSessions(data: unknown): ListedDaemonSession[] {
  if (!data || typeof data !== 'object') return [];
  const children = (data as { children?: unknown }).children;
  if (!Array.isArray(children)) return [];
  return children.flatMap((child): ListedDaemonSession[] => {
    if (!child || typeof child !== 'object') return [];
    const record = child as Record<string, unknown>;
    const happySessionId = typeof record.happySessionId === 'string' ? record.happySessionId : '';
    const startedBy = typeof record.startedBy === 'string' ? record.startedBy : '';
    const pid = typeof record.pid === 'number' ? record.pid : 0;
    if (!happySessionId || !startedBy || pid <= 0) return [];
    return [{ happySessionId, startedBy, pid }];
  });
}

async function listDaemonSessions(params: {
  port: number;
  controlToken?: string | null;
}): Promise<ListedDaemonSession[]> {
  const listed = await daemonControlPostJson({
    port: params.port,
    path: '/list',
    controlToken: params.controlToken,
  });
  expect(listed.status).toBe(200);
  return parseListedDaemonSessions(listed.data);
}

async function resolveSpawnedSessionId(params: {
  port: number;
  controlToken?: string | null;
  spawnNonce?: string;
  immediateSessionId?: string;
  timeoutMs?: number;
}): Promise<string> {
  const immediateSessionId = typeof params.immediateSessionId === 'string' ? params.immediateSessionId.trim() : '';
  if (immediateSessionId) return immediateSessionId;

  const spawnNonce = typeof params.spawnNonce === 'string' ? params.spawnNonce.trim() : '';
  if (!spawnNonce) {
    throw new Error('Missing sessionId and spawnNonce from daemon spawn-session');
  }

  let resolvedSessionId = '';
  await waitFor(async () => {
    const resolved = await daemonControlPostJson<{
      success: true;
      status: 'success' | 'pending' | 'not_found';
      sessionId?: string;
    }>({
      port: params.port,
      path: '/spawn-session/resolve',
      controlToken: params.controlToken,
      body: { spawnNonce },
      timeoutMs: 5_000,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.data.success).toBe(true);
    if (resolved.data.status !== 'success') {
      throw new Error(`spawn-session/resolve returned ${resolved.data.status}`);
    }
    const sessionId = typeof resolved.data.sessionId === 'string' ? resolved.data.sessionId.trim() : '';
    if (!sessionId) {
      throw new Error('spawn-session/resolve did not return a sessionId');
    }
    resolvedSessionId = sessionId;
    return true;
  }, {
    timeoutMs: params.timeoutMs ?? 45_000,
    intervalMs: 50,
    context: 'spawn-session nonce resolution',
  });

  if (!resolvedSessionId) {
    throw new Error('Failed to resolve spawned session id from nonce');
  }
  return resolvedSessionId;
}

async function waitForReplacementDaemonConfirmed(params: {
  happyHomeDir: string;
  originalPid: number;
  timeoutMs?: number;
}): Promise<DaemonState> {
  let replacement: DaemonState | null = null;
  await waitFor(async () => {
    const state = await readDaemonState(params.happyHomeDir);
    if (!state || state.pid === params.originalPid || state.pid <= 0 || state.httpPort <= 0) {
      throw new Error('replacement daemon state not visible yet');
    }
    if (!isPidAlive(state.pid)) {
      throw new Error(`replacement daemon pid ${state.pid} is not alive`);
    }
    const ping = await daemonControlPostJson({
      port: state.httpPort,
      path: '/ping',
      controlToken: state.controlToken,
      timeoutMs: 2_000,
    });
    expect(ping.status).toBe(200);
    replacement = state;
    return true;
  }, {
    timeoutMs: params.timeoutMs ?? 45_000,
    intervalMs: 10,
    context: 'replacement daemon confirmed by state and /ping',
  });
  if (!replacement) throw new Error('replacement daemon was not confirmed');
  return replacement;
}

function waitForDaemonChildExit(daemon: StartedDaemon, timeoutMs: number): Promise<'exited' | 'timeout'> {
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit('timeout'), timeoutMs);
    daemon.proc.child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit('exited');
    });
  });
}

describe('core e2e: daemon overlap self-restart', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let daemonHomeDir: string | null = null;

  afterEach(async () => {
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
      daemonHomeDir = null;
    }
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
    }
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('confirms the replacement daemon before the old daemon exits while keeping the session runner singular', async () => {
    const testDir = run.testDir(`daemon-restart-overlap-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS: '25',
      // Source-mode replacement startup can take several seconds under E2E lane load.
      HAPPIER_DAEMON_RESTART_OVERLAP_EXIT_GRACE_MS: '5000',
    };

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      cleanupDescendantsOnExit: false,
    });
    const originalDaemonPid = daemon.state.pid;

    const spawnRes = await daemonControlPostJson({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        environmentVariables: daemonEnv,
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = await resolveSpawnedSessionId({
      port: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      immediateSessionId: typeof spawnRes.data.sessionId === 'string' ? spawnRes.data.sessionId : '',
      spawnNonce: typeof spawnRes.data.spawnNonce === 'string' ? spawnRes.data.spawnNonce : '',
    });

    const firstPrompt = `DAEMON_RESTART_OVERLAP_FIRST_${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: firstPrompt,
    });

    const firstSdkInvocation = await waitForFakeClaudeInvocation(fakeLogPath, (invocation) => invocation.mode === 'sdk', { timeoutMs: 60_000 });
    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: 'FAKE_CLAUDE_OK_1',
      timeoutMs: 120_000,
    });
    const firstSdkPid = firstSdkInvocation.pid;
    if (typeof firstSdkPid !== 'number') {
      throw new Error('Expected fake Claude SDK invocation to record a numeric PID');
    }
    assertPidAlive(firstSdkPid);
    const claudeSessionIdBefore = await readFakeClaudeSessionId({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
    });
    expect(claudeSessionIdBefore).toBeTruthy();

    const beforeSessions = await listDaemonSessions({
      port: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
    });
    const beforeMatches = beforeSessions.filter((child) => child.happySessionId === sessionId);
    expect(beforeMatches).toHaveLength(1);
    const originalRunnerPid = beforeMatches[0]?.pid;
    if (typeof originalRunnerPid !== 'number' || originalRunnerPid <= 0) {
      throw new Error('Expected daemon /list to expose the original runner PID');
    }

    const oldExit = waitForDaemonChildExit(daemon, 45_000);
    const replacementPromise = waitForReplacementDaemonConfirmed({
      happyHomeDir: daemonHomeDir,
      originalPid: originalDaemonPid,
    });
    const restart = await daemonControlPostJson({
      port: daemon.state.httpPort,
      path: '/restart',
      controlToken: daemon.state.controlToken,
      body: {},
      timeoutMs: 5_000,
    });
    expect(restart.status).toBe(202);
    expect(restart.data).toEqual({ status: 'restarting' });

    const firstObserved = await Promise.race([
      replacementPromise.then((state) => ({ kind: 'replacement' as const, state })),
      oldExit.then((status) => ({ kind: 'old_exit' as const, status })),
    ]);
    expect(firstObserved.kind).toBe('replacement');
    if (firstObserved.kind !== 'replacement') {
      throw new Error(`old daemon exited before replacement was confirmed (${firstObserved.status})`);
    }
    const replacementState = firstObserved.state;
    expect(replacementState.pid).not.toBe(originalDaemonPid);

    await waitFor(async () => {
      if (isPidAlive(originalDaemonPid)) {
        throw new Error(`old daemon pid ${originalDaemonPid} is still alive`);
      }
      return true;
    }, { timeoutMs: 30_000, context: 'old daemon exits after replacement confirmation' });

    const afterSessions = await listDaemonSessions({
      port: replacementState.httpPort,
      controlToken: replacementState.controlToken,
    });
    const afterMatches = afterSessions.filter((child) => child.happySessionId === sessionId);
    expect(afterMatches).toHaveLength(1);
    expect(afterMatches[0]).toEqual(expect.objectContaining({
      happySessionId: sessionId,
      startedBy: 'daemon',
      pid: originalRunnerPid,
    }));
    expect(afterSessions.filter((child) => child.pid === originalRunnerPid)).toHaveLength(1);
    assertPidAlive(firstSdkPid);
    expect(await readFakeClaudeSdkInvocationCount(fakeLogPath)).toBe(1);

    const afterRestartSeq = maxMessageSeq(await fetchAllMessages(server.baseUrl, auth.token, sessionId));
    const secondPrompt = `DAEMON_RESTART_OVERLAP_SECOND_${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: secondPrompt,
    });

    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: 'FAKE_CLAUDE_OK_2',
      afterSeqStart: afterRestartSeq,
      timeoutMs: 120_000,
    });

    const finalMessages = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    expect(countDuplicateLocalIds(finalMessages)).toBe(0);
    expect(await readFakeClaudeSdkInvocationCount(fakeLogPath)).toBe(1);
    expect(
      await readFakeClaudeSessionId({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        secret,
      }),
    ).toBe(claudeSessionIdBefore);
  }, TEST_TIMEOUT_MS);
});
