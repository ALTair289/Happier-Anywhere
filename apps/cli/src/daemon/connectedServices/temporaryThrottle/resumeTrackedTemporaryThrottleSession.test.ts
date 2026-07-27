import { describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '@/daemon/types';

import { resumeTrackedTemporaryThrottleSession } from './resumeTrackedTemporaryThrottleSession';

function createTracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: 'sess-1',
    pid: 123,
    vendorResumeId: 'vendor-old',
    spawnOptions: {
      directory: '/tmp/project',
      machineId: 'machine-1',
      sessionId: 'new-session-id-should-not-survive',
      pendingFirstInput: { text: 'do not send this again', localId: 'spawn-first:nonce' },
      resume: 'vendor-from-options',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    },
    ...overrides,
  };
}

describe('resumeTrackedTemporaryThrottleSession', () => {
  it('respawns an existing session with refreshed runtime options and no duplicated initial prompt', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess-1',
    }));
    const resolveRespawnOptions = vi.fn(async ({ defaultOptions }: {
      defaultOptions: SpawnSessionOptions;
    }) => ({
      ...defaultOptions,
      resume: 'vendor-fresh',
      modelId: 'fresh-model',
    }));

    await expect(resumeTrackedTemporaryThrottleSession({
      tracked: createTracked(),
      credentials: null,
      readCredentials: async () => null,
      spawnSession,
      resolveRespawnOptions,
    })).resolves.toMatchObject({
      status: 'resumed',
      sessionId: 'sess-1',
    });

    expect(resolveRespawnOptions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      vendorResumeId: 'vendor-old',
      defaultOptions: expect.objectContaining({
        existingSessionId: 'sess-1',
        resume: 'vendor-old',
        approvedNewDirectoryCreation: true,
      }),
    }));
    expect(resolveRespawnOptions.mock.calls[0]?.[0].defaultOptions).not.toHaveProperty('pendingFirstInput');
    expect(resolveRespawnOptions.mock.calls[0]?.[0].defaultOptions).not.toHaveProperty('sessionId', 'new-session-id-should-not-survive');
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess-1',
      resume: 'vendor-fresh',
      modelId: 'fresh-model',
    }));
  });

  it('allows the runtime snapshot resolver to derive the vendor resume id from persisted metadata', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess-1',
    }));
    const resolveRespawnOptions = vi.fn(async ({ defaultOptions }: {
      defaultOptions: SpawnSessionOptions;
    }) => ({
      ...defaultOptions,
      resume: 'vendor-from-metadata',
    }));

    await expect(resumeTrackedTemporaryThrottleSession({
      tracked: createTracked({
        vendorResumeId: undefined,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        },
      }),
      credentials: null,
      readCredentials: async () => null,
      spawnSession,
      resolveRespawnOptions,
    })).resolves.toMatchObject({ status: 'resumed' });

    expect(resolveRespawnOptions).toHaveBeenCalledWith(expect.objectContaining({
      vendorResumeId: '',
      defaultOptions: expect.not.objectContaining({ resume: expect.any(String) }),
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      resume: 'vendor-from-metadata',
    }));
  });

  it('reports unavailable recovery when tracked spawn options are missing', async () => {
    const spawnSession = vi.fn();

    await expect(resumeTrackedTemporaryThrottleSession({
      tracked: createTracked({ spawnOptions: undefined }),
      credentials: null,
      readCredentials: async () => null,
      spawnSession,
    })).resolves.toEqual({
      status: 'unavailable',
      reason: 'spawn_options_missing',
    });

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('reports failed recovery when the respawn request is rejected', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'error',
      errorCode: 'SPAWN_FAILED',
      errorMessage: 'provider refused to start',
    }));

    await expect(resumeTrackedTemporaryThrottleSession({
      tracked: createTracked(),
      credentials: null,
      readCredentials: async () => null,
      spawnSession,
      resolveRespawnOptions: ({ defaultOptions }) => defaultOptions,
    })).resolves.toMatchObject({
      status: 'failed',
      reason: 'spawn_failed',
      errorCode: 'SPAWN_FAILED',
    });
  });
});
