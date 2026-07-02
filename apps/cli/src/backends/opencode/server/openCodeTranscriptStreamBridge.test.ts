import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createOpenCodeTranscriptStreamBridge } from './openCodeTranscriptStreamBridge';
import { createOpenCodeTranscriptStreamSession } from './createOpenCodeTranscriptStreamSession';

async function flushTranscriptCommitMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createSessionStub() {
  const durableCalls: Array<Record<string, unknown>> = [];
  const bestEffortCalls: Array<Record<string, unknown>> = [];

  const session = {
    sendAgentMessageCommitted: async (provider: unknown, body: unknown, opts: Record<string, unknown>) => {
      durableCalls.push({ provider, body, ...opts });
    },
    sendAgentMessage: (provider: unknown, body: unknown, opts: Record<string, unknown>) => {
      bestEffortCalls.push({ provider, body, ...opts });
    },
  };

  return { session, durableCalls, bestEffortCalls };
}

describe('createOpenCodeTranscriptStreamBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('streams assistant deltas via durable checkpoints that reuse the segment localId after projection is confirmed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: session as any,
    });

    bridge.appendAssistantDelta({
      deltaText: 'Hello',
      streamKey: 'stream-1',
      remoteSessionId: 'ses_1',
      messageId: 'msg_1',
      sidechainId: null,
    });
    bridge.appendAssistantDelta({
      deltaText: '.',
      streamKey: 'stream-1',
      remoteSessionId: 'ses_1',
      messageId: 'msg_1',
      sidechainId: null,
    });

    await vi.advanceTimersByTimeAsync(500);
    await flushTranscriptCommitMicrotasks();

    expect(durableCalls).toHaveLength(0);

    bridge.enableDurableCommitsForStream({
      streamKey: 'stream-1',
      remoteSessionId: 'ses_1',
      messageId: 'msg_1',
      sidechainId: null,
    });
    await flushTranscriptCommitMicrotasks();

    await bridge.flushAll({ reason: 'turn-end' });
    await flushTranscriptCommitMicrotasks();

    expect(durableCalls.map((row) => (row.body as any)?.message)).toEqual(['Hello.', 'Hello.']);
    expect(durableCalls[0]?.localId).toBeTruthy();
    expect(durableCalls[1]?.localId).toBe(durableCalls[0]?.localId);
    expect((durableCalls[0]?.meta as any)?.happierStreamKey).toBe('stream-1');
    expect((durableCalls[1]?.meta as any)?.happierStreamSegmentV1).toMatchObject({
      segmentKind: 'assistant',
      segmentLocalId: durableCalls[0]?.localId,
      segmentState: 'complete',
    });
  });

  it('drops a streamed compaction summary before any durable transcript checkpoint can persist it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: session as any,
    });

    bridge.appendAssistantDelta({
      deltaText: '## Goal\n- Internal compaction summary',
      streamKey: 'stream-summary',
      remoteSessionId: 'ses_1',
      messageId: 'msg_compaction',
      sidechainId: null,
    });

    await vi.advanceTimersByTimeAsync(500);
    await flushTranscriptCommitMicrotasks();

    bridge.discardStream({
      streamKey: 'stream-summary',
      remoteSessionId: 'ses_1',
      messageId: 'msg_compaction',
      sidechainId: null,
    });

    await bridge.flushAll({ reason: 'turn-end' });
    await flushTranscriptCommitMicrotasks();

    expect(durableCalls).toHaveLength(0);
  });

  it('preserves sidechain metadata and completion state on sidechain assistant streams', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: session as any,
    });

    bridge.appendAssistantDelta({
      deltaText: 'CHILD_OK',
      streamKey: 'stream-child',
      remoteSessionId: 'ses_child_1',
      messageId: 'msg_child_1',
      sidechainId: 'call_task_1',
    });
    await flushTranscriptCommitMicrotasks();

    expect(durableCalls.map((row) => (row.body as any)?.message)).toEqual(['CHILD_OK']);

    await bridge.flushAll({ reason: 'turn-end' });
    await flushTranscriptCommitMicrotasks();

    const finalCall = durableCalls[durableCalls.length - 1]!;
    expect((finalCall.body as any)).toMatchObject({ type: 'message', message: 'CHILD_OK', sidechainId: 'call_task_1' });
    expect(finalCall.meta).toMatchObject({
      happierStreamKey: 'stream-child',
      importedFrom: 'acp-sidechain',
      remoteSessionId: 'ses_child_1',
      sidechainId: 'call_task_1',
      happierSidechainStreamKey: 'stream-child',
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('flushes only matching sidechain streams at tool-call boundaries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: session as any,
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    bridge.appendAssistantDelta({
      deltaText: 'Root before',
      streamKey: 'stream-root',
      remoteSessionId: 'ses_root',
      messageId: 'msg_root',
      sidechainId: null,
    });
    bridge.enableDurableCommitsForStream({
      streamKey: 'stream-root',
      remoteSessionId: 'ses_root',
      messageId: 'msg_root',
      sidechainId: null,
    });
    await flushTranscriptCommitMicrotasks();

    bridge.appendAssistantDelta({
      deltaText: 'Child text',
      streamKey: 'stream-child',
      remoteSessionId: 'ses_child',
      messageId: 'msg_child',
      sidechainId: 'task-call-1',
    });
    await flushTranscriptCommitMicrotasks();

    const initialRootLocalId = durableCalls.find((row) => (row.body as any)?.sidechainId === undefined)?.localId;
    expect(initialRootLocalId).toEqual(expect.any(String));

    await bridge.flushStreamsMatching({
      reason: 'tool-call-boundary',
      matches: (stream) => stream.sidechainId === 'task-call-1',
    });
    await flushTranscriptCommitMicrotasks();

    bridge.appendAssistantDelta({
      deltaText: ' and after',
      streamKey: 'stream-root',
      remoteSessionId: 'ses_root',
      messageId: 'msg_root',
      sidechainId: null,
    });
    await flushTranscriptCommitMicrotasks();

    const rootCalls = durableCalls.filter((row) => (row.body as any)?.sidechainId === undefined);
    const childCalls = durableCalls.filter((row) => (row.body as any)?.sidechainId === 'task-call-1');

    expect(rootCalls.map((row) => row.localId)).toEqual([initialRootLocalId, initialRootLocalId]);
    expect((rootCalls.at(-1)?.body as any)?.message).toBe('Root before and after');
    expect(childCalls.at(-1)?.meta).toMatchObject({
      importedFrom: 'acp-sidechain',
      sidechainId: 'task-call-1',
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('forwards ephemeral stream snapshots with the same sidechain metadata as durable sends', () => {
    const ephemeralCalls: Array<{
      provider: ACPProvider;
      body: ACPMessageData;
      opts: {
        localId: string;
        createdAt: number;
        updatedAt?: number;
        meta?: Record<string, unknown>;
      };
    }> = [];

    const session = createOpenCodeTranscriptStreamSession({
      baseMeta: {
        happierStreamKey: 'stream-child',
        importedFrom: 'acp-sidechain',
        remoteSessionId: 'ses_child_1',
        sidechainId: 'call_task_1',
        happierSidechainStreamKey: 'stream-child',
      },
      session: {
        sendAgentMessageCommitted: async () => {},
        sendAgentMessage: () => {},
        sendAgentMessageEphemeral: (provider, body, opts) => {
          ephemeralCalls.push({ provider, body, opts });
        },
      },
    });

    expect(session.sendAgentMessageEphemeral).toBeTypeOf('function');

    session.sendAgentMessageEphemeral?.(
      'opencode',
      { type: 'message', message: 'CHILD_OK', sidechainId: 'call_task_1' },
      {
        localId: 'segment-1',
        createdAt: 10,
        updatedAt: 20,
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'segment-1',
            segmentState: 'streaming',
            updatedAtMs: 20,
          },
        },
      },
    );

    expect(ephemeralCalls).toEqual([
      {
        provider: 'opencode',
        body: { type: 'message', message: 'CHILD_OK', sidechainId: 'call_task_1' },
        opts: {
          localId: 'segment-1',
          createdAt: 10,
          updatedAt: 20,
          meta: {
            happierStreamKey: 'stream-child',
            importedFrom: 'acp-sidechain',
            remoteSessionId: 'ses_child_1',
            sidechainId: 'call_task_1',
            happierSidechainStreamKey: 'stream-child',
            happierStreamSegmentV1: {
              v: 1,
              segmentKind: 'assistant',
              segmentLocalId: 'segment-1',
              segmentState: 'streaming',
              updatedAtMs: 20,
            },
          },
        },
      },
    ]);
  });

  it('forwards ephemeral stream deltas with merged base metadata and exposes the connection epoch', () => {
    const deltaCalls: Array<{
      provider: ACPProvider;
      body: ACPMessageData;
      opts: {
        localId: string;
        tick: number;
        baseLength: number;
        createdAt: number;
        updatedAt?: number;
        meta?: Record<string, unknown>;
      };
    }> = [];

    const session = createOpenCodeTranscriptStreamSession({
      baseMeta: { importedFrom: 'acp-sidechain' },
      session: {
        sendAgentMessageCommitted: async () => {},
        sendAgentMessage: () => {},
        sendAgentMessageEphemeral: () => {},
        sendAgentMessageEphemeralDelta: (provider, body, opts) => {
          deltaCalls.push({ provider, body, opts });
        },
        getEphemeralStreamConnectionEpoch: () => 4,
      },
    });

    expect(session.sendAgentMessageEphemeralDelta).toBeTypeOf('function');
    session.sendAgentMessageEphemeralDelta?.(
      'opencode',
      { type: 'message', message: '_DELTA' },
      { localId: 'segment-1', tick: 2, baseLength: 8, createdAt: 10, updatedAt: 20 },
    );

    expect(deltaCalls).toEqual([
      {
        provider: 'opencode',
        body: { type: 'message', message: '_DELTA' },
        opts: {
          localId: 'segment-1',
          tick: 2,
          baseLength: 8,
          createdAt: 10,
          updatedAt: 20,
          meta: { importedFrom: 'acp-sidechain' },
        },
      },
    ]);
    expect(session.getEphemeralStreamConnectionEpoch?.()).toBe(4);
  });

  it('does not advertise delta sends when the underlying session lacks support', () => {
    const session = createOpenCodeTranscriptStreamSession({
      baseMeta: {},
      session: {
        sendAgentMessageCommitted: async () => {},
        sendAgentMessage: () => {},
        sendAgentMessageEphemeral: () => {},
      },
    });

    expect(session.sendAgentMessageEphemeralDelta).toBeUndefined();
    expect(session.getEphemeralStreamConnectionEpoch).toBeUndefined();
  });

  it('routes streamed committed snapshots through the durable enqueue hook when available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const sendAgentMessageCommitted = vi.fn(async () => {});
    const enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true as const, delivered: false }));
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: {
        sendAgentMessageCommitted,
        enqueueAgentMessageCommitted,
        sendAgentMessage: () => {},
      } as any,
    });

    bridge.appendAssistantDelta({
      deltaText: 'Hello durable outbox',
      streamKey: 'stream-1',
      remoteSessionId: 'ses_1',
      messageId: 'msg_1',
      sidechainId: null,
    });
    bridge.enableDurableCommitsForStream({
      streamKey: 'stream-1',
      remoteSessionId: 'ses_1',
      messageId: 'msg_1',
      sidechainId: null,
    });

    await bridge.flushAll({ reason: 'turn-end' });
    await flushTranscriptCommitMicrotasks();

    expect(sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'Hello durable outbox' },
      expect.objectContaining({
        localId: expect.any(String),
        meta: expect.objectContaining({
          happierStreamKey: 'stream-1',
          opencodeMessageId: 'msg_1',
          opencodeRemoteSessionId: 'ses_1',
          happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
        }),
      }),
    );
  });
});
