import { describe, expect, it, vi } from 'vitest';

import { createCurrentSessionTranscriptPort } from './createCurrentSessionTranscriptPort';
import { createStreamedTranscriptWriter } from './streamedTranscriptWriter';

async function settleCommittedSnapshot() {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('createCurrentSessionTranscriptPort', () => {
  it('routes transcript-vNext writes through the latest swapped session', async () => {
    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession);

    currentSession = secondSession;

    await port.sendAgentMessageCommitted(
      'gemini' as any,
      { type: 'thinking', text: 'final' } as any,
      { localId: 'commit_1' },
    );

    expect(firstSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'gemini',
      { type: 'thinking', text: 'final' },
      { localId: 'commit_1' },
    );
  });

  it('routes ephemeral stream segment writes through the latest swapped session', () => {
    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    currentSession = secondSession;

    expect(port.sendAgentMessageEphemeral).toBeTypeOf('function');
    const expectedOutcome = { accepted: true as const, epoch: 2 };
    secondSession.sendAgentMessageEphemeral.mockReturnValue(expectedOutcome);
    const outcome = port.sendAgentMessageEphemeral?.(
      'codex',
      { type: 'message', message: 'live' },
      { localId: 'segment-1', createdAt: 1_000, updatedAt: 1_025 },
    );

    expect(firstSession.sendAgentMessageEphemeral).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageEphemeral).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'live' },
      { localId: 'segment-1', createdAt: 1_000, updatedAt: 1_025 },
    );
    expect(outcome).toBe(expectedOutcome);
  });

  it('fails closed when support disappears between capability lookup and invocation', () => {
    const firstSession = {
      sendAgentMessageEphemeral: vi.fn(() => ({ accepted: true as const, epoch: 1 })),
      getEphemeralStreamConnectionEpoch: vi.fn(() => 1),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    const secondSession = {
      getEphemeralStreamConnectionEpoch: vi.fn(() => 8),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    let currentSession: typeof firstSession | typeof secondSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession);
    const send = port.sendAgentMessageEphemeral;

    currentSession = secondSession;
    const outcome = send?.(
      'codex',
      { type: 'message', message: 'live' },
      { localId: 'segment-1', createdAt: 1_000 },
    );

    expect(outcome).toEqual({
      accepted: false,
      epoch: 8,
      reason: { code: 'transport_unavailable' },
    });
  });

  it('routes streamed committed snapshots through the latest session durable enqueue hook', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {
        throw new Error('stale direct committed path should not be used');
      }),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {
        throw new Error('direct committed path should not be used');
      }),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);
    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: port as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });
    writer.setCommitProvenance({ kind: 'non_dependent', source: 'external' });

    currentSession = secondSession;
    writer.appendAssistantDelta('final');
    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(firstSession.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(firstSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'final' },
      expect.objectContaining({ localId: 'segment-1' }),
    );
  });

  it('keeps no-provenance committed snapshots on the direct commit path', async () => {
    const session = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
    };
    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session,
      makeLocalId: () => 'segment-no-provenance',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('direct');
    await writer.flushAll({ reason: 'turn-end' });

    expect(session.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'direct' },
      expect.objectContaining({ localId: 'segment-no-provenance' }),
    );
    expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('retries the same retained segment after an unavailable session is replaced', async () => {
    const offlineSession = {
      sendAgentMessageCommitted: vi.fn(async () => {
        throw new Error('Offline transcript write was not persisted');
      }),
    };
    const attachedSession = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    let currentSession: typeof offlineSession | typeof attachedSession = offlineSession;
    const writer = createStreamedTranscriptWriter({
      provider: 'gemini',
      session: createCurrentSessionTranscriptPort(() => currentSession),
      makeLocalId: () => 'retained-segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('retained');
    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();
    expect(offlineSession.sendAgentMessageCommitted).toHaveBeenCalled();

    currentSession = attachedSession;
    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(attachedSession.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'gemini',
      { type: 'message', message: 'retained' },
      expect.objectContaining({ localId: 'retained-segment-1' }),
    );
  });

  it('does not advertise ephemeral stream segment writes when the current session lacks support', () => {
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };

    const port = createCurrentSessionTranscriptPort(() => session);

    expect(port.sendAgentMessageEphemeral).toBeUndefined();
    expect(port.sendAgentMessageEphemeralDelta).toBeUndefined();
    expect(port.getEphemeralStreamConnectionEpoch).toBeUndefined();
  });

  it('routes ephemeral stream delta writes and connection epochs through the latest swapped session', () => {
    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn(),
      sendAgentMessageEphemeralDelta: vi.fn(),
      getEphemeralStreamConnectionEpoch: vi.fn(() => 1),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn(),
      sendAgentMessageEphemeralDelta: vi.fn(),
      getEphemeralStreamConnectionEpoch: vi.fn(() => 7),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    currentSession = secondSession;

    expect(port.sendAgentMessageEphemeralDelta).toBeTypeOf('function');
    port.sendAgentMessageEphemeralDelta?.(
      'codex',
      { type: 'message', message: ' live' },
      { localId: 'segment-1', tick: 2, baseLength: 4, createdAt: 1_000, updatedAt: 1_040 },
    );

    expect(firstSession.sendAgentMessageEphemeralDelta).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageEphemeralDelta).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: ' live' },
      { localId: 'segment-1', tick: 2, baseLength: 4, createdAt: 1_000, updatedAt: 1_040 },
    );

    expect(port.getEphemeralStreamConnectionEpoch?.()).toBe(7);
    expect(firstSession.getEphemeralStreamConnectionEpoch).not.toHaveBeenCalled();
  });

  it('forces a full checkpoint when the current session is replaced at the same source epoch', async () => {
    const firstAcceptance = createDeferred<{ accepted: true; epoch: number }>();
    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn(() => firstAcceptance.promise),
      sendAgentMessageEphemeralDelta: vi.fn(() => ({ accepted: true as const, epoch: 1 })),
      getEphemeralStreamConnectionEpoch: vi.fn(() => 1),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn(() => ({ accepted: true as const, epoch: 1 })),
      sendAgentMessageEphemeralDelta: vi.fn(() => ({ accepted: true as const, epoch: 1 })),
      getEphemeralStreamConnectionEpoch: vi.fn(() => 1),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    let currentSession: typeof firstSession | typeof secondSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession);
    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session: port,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: 0,
      liveSnapshotMinChars: 1,
      liveCheckpointIntervalMs: 10_000,
    });

    writer.appendAssistantDelta('hello');
    currentSession = secondSession;
    writer.appendAssistantDelta(' world');
    firstAcceptance.resolve({ accepted: true, epoch: 1 });
    await settleCommittedSnapshot();

    expect(secondSession.sendAgentMessageEphemeral).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'hello world' },
      expect.objectContaining({ localId: 'segment-1' }),
    );
    expect(secondSession.sendAgentMessageEphemeralDelta).not.toHaveBeenCalled();
    writer.discard();
  });
});
