import { describe, expect, it } from 'vitest';

import { SessionRunnerRuntimeStateV1Schema } from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import type { SessionRunnerEntrypointIdentity } from './types';
import { resolveSessionRunnerRuntimeState } from './resolveRuntimeState';

function currentIdentity(version: string): SessionRunnerEntrypointIdentity {
  return {
    status: 'known',
    source: 'launch_spec',
    comparableId: `version:${version}`,
    entrypointVersion: version,
  };
}

function unknownCurrentIdentity(): SessionRunnerEntrypointIdentity {
  return { status: 'unknown', source: 'unknown', reason: 'entrypoint_not_found' };
}

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    processCommand:
      'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
    vendorResumeId: 'claude-thread-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
    ...overrides,
  };
}

describe('resolveSessionRunnerRuntimeState', () => {
  it('reports current only when runner and canonical launch identities match', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.10'),
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('current');
    expect(state.runner.runtimeId).toBe('version:0.2.10');
    expect(state.runner.processCommandHash).toBe('hash-1');
    expect(state.daemon.currentEntrypointVersion).toBe('version:0.2.10');
    expect(state.plannedRestart).toEqual({
      supported: true,
      eligible: true,
      disabledReason: null,
    });
    expect(SessionRunnerRuntimeStateV1Schema.parse(state)).toEqual(state);
  });

  it('threads daemon and machine identity into published runtime state when supplied', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      machineId: ' machine-1 ',
      daemonId: ' daemon-1 ',
      observedAtMs: 100,
    });

    expect(state.machineId).toBe('machine-1');
    expect(state.daemonId).toBe('daemon-1');
    expect(SessionRunnerRuntimeStateV1Schema.parse(state)).toEqual(state);
  });

  it('reports stale when the runner command identity differs from the current launch identity', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('stale');
    expect(state.runner.runtimeId).toBe('version:0.2.10');
    expect(state.daemon.currentEntrypointVersion).toBe('version:0.2.11');
  });

  it('fails closed when the runner command cannot be resolved', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession({ processCommand: 'node --happy-starting-mode remote' }),
      currentIdentity: currentIdentity('0.2.11'),
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('unknown');
    expect(state.plannedRestart.eligible).toBe(false);
    expect(state.plannedRestart.disabledReason).toBe('runner_entrypoint_unknown');
  });

  it('fails closed when the current daemon entrypoint identity cannot be resolved', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession(),
      currentIdentity: unknownCurrentIdentity(),
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('unknown');
    expect(state.daemon.currentEntrypointSource).toBe('unknown');
    expect(state.plannedRestart.eligible).toBe(false);
    expect(state.plannedRestart.disabledReason).toBe('current_entrypoint_unknown');
  });

  it('marks missing restart context ineligible while preserving stale status evidence', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession({ spawnOptions: undefined }),
      currentIdentity: currentIdentity('0.2.11'),
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('stale');
    expect(state.plannedRestart.eligible).toBe(false);
    expect(state.plannedRestart.disabledReason).toBe('missing_spawn_options');
  });

  it('rejects daemon-started local mode runners from planned restart eligibility', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession({
        processCommand:
          'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode local --started-by daemon',
      }),
      currentIdentity: currentIdentity('0.2.11'),
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('stale');
    expect(state.runner.startingMode).toBe('local');
    expect(state.plannedRestart.eligible).toBe(false);
    expect(state.plannedRestart.disabledReason).toBe('not_remote_started');
  });

  it('rejects runners whose starting mode cannot be proven remote', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession({
        processCommand:
          'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --started-by daemon',
      }),
      currentIdentity: currentIdentity('0.2.11'),
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('stale');
    expect(state.runner.startingMode).toBe('unknown');
    expect(state.plannedRestart.eligible).toBe(false);
    expect(state.plannedRestart.disabledReason).toBe('not_remote_started');
  });

  it('rejects Windows-hosted runners from planned restart eligibility', () => {
    const base = trackedSession();
    if (!base.spawnOptions) throw new Error('Expected spawn options fixture');
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession({
        spawnOptions: {
          ...base.spawnOptions,
          windowsRemoteSessionLaunchMode: 'windows_terminal',
        } satisfies SpawnSessionOptions,
      }),
      currentIdentity: currentIdentity('0.2.11'),
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('stale');
    expect(state.plannedRestart.eligible).toBe(false);
    expect(state.plannedRestart.disabledReason).toBe('windows_hosted_runner');
  });

  it('marks otherwise eligible runners ineligible while a turn is in progress', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      observedAtMs: 100,
      resolveActivityDisabledReason: () => 'turn_in_progress',
    });

    expect(state.versionState).toBe('stale');
    expect(state.plannedRestart.eligible).toBe(false);
    expect(state.plannedRestart.disabledReason).toBe('turn_in_progress');
  });
});
