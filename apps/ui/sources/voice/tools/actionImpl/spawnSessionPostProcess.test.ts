import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshSessions = vi.fn(async () => {});
const patchSessionMetadataWithRetry = vi.fn(async () => {});
const sendMessage = vi.fn(async () => {});
const submitMessage = vi.fn(async () => {});
const followUpSpawnedSessionWithServerScope = vi.fn(async () => {});

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions,
    patchSessionMetadataWithRetry,
    sendMessage,
    submitMessage,
  },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
  followUpSpawnedSessionWithServerScope,
}));

describe('postprocessSpawnedSession', () => {
  beforeEach(() => {
    refreshSessions.mockClear();
    patchSessionMetadataWithRetry.mockClear();
    sendMessage.mockClear();
    submitMessage.mockClear();
    followUpSpawnedSessionWithServerScope.mockClear();
  });

  it('submits a voice-created session first turn through the durable pending action path', async () => {
    const { postprocessSpawnedSession } = await import('./spawnSessionPostProcess');

    await postprocessSpawnedSession({
      sessionId: 's1',
      serverId: 'server-a',
      initialMessage: 'start this task',
      firstTurnLocalId: 'voice-first-turn-1',
    });

    expect(followUpSpawnedSessionWithServerScope).toHaveBeenCalledWith({
      sessionId: 's1',
      targetServerId: 'server-a',
      initialMessageText: 'start this task',
      messageLocalId: 'voice-first-turn-1',
    });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
