import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { encodeBase64, encrypt } from '../encryption';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

const enqueueSessionTurnMock = vi.fn(async (_mutation: unknown) => {});
const enqueueSessionEndMock = vi.fn(async (_mutation: unknown) => {});
const enqueueTranscriptMessageMock = vi.fn(async (_mutation: unknown) => ({ persisted: true, delivered: true }));
const flushOutboxMock = vi.fn(async (_reason: unknown) => {});
const closeOutboxMock = vi.fn(async () => {});
let terminalTurnWriteGate: ReturnType<typeof createDeferred<void>> | null = null;

vi.mock('./mutations/createSessionMutationOutbox', () => ({
  createSessionMutationOutbox: () => ({
    enqueueSessionTurn: (mutation: { action?: unknown }) => {
      enqueueSessionTurnMock(mutation);
      if (
        terminalTurnWriteGate
        && (
          mutation.action === 'complete'
          || mutation.action === 'fail'
          || mutation.action === 'cancel'
        )
      ) {
        return terminalTurnWriteGate.promise;
      }
      return Promise.resolve();
    },
    enqueueSessionEnd: (mutation: unknown) => enqueueSessionEndMock(mutation),
    enqueueTranscriptMessage: (mutation: unknown) => enqueueTranscriptMessageMock(mutation),
    flush: (reason: unknown) => flushOutboxMock(reason),
    close: () => closeOutboxMock(),
  }),
}));

let supervisorPhase = 'online';

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
    getState: () => ({ phase: supervisorPhase }),
  }),
}));

const catchUpMock = vi.fn(async (_opts?: unknown) => {});

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: (opts: unknown) => catchUpMock(opts),
}));

const fetchSnapshotMock = vi.fn();
const materializeNextMock = vi.fn();
const resolveAcceptedPendingDeliveryMock = vi.fn();
const reconcileAcceptedPendingDeliveriesThroughSeqMock = vi.fn();
const blockPendingDeliveryMock = vi.fn();
const blockProviderDeliveriesOnAttachMock = vi.fn();
const listProviderDeliveryLocalIdsMock = vi.fn();
const resolveCliFeatureDecisionForServerMock = vi.fn();
let sessionClientModulePromise: Promise<typeof import('./sessionClient')> | null = null;

function createFeatureDecision(state: 'enabled' | 'unsupported' | 'unknown' = 'enabled') {
  return {
    featureId: 'sharing.pendingDeliveryState',
    state,
    evaluatedAt: Date.now(),
    scope: { scopeKind: 'runtime' },
    diagnostics: [],
  };
}

vi.mock('@/features/featureDecisionService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/featureDecisionService')>();
  return {
    ...actual,
    resolveCliFeatureDecisionForServer: (...args: unknown[]) => resolveCliFeatureDecisionForServerMock(...args),
  };
});

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextMock(...args),
    resolveAcceptedPendingQueueV2Delivery: (...args: unknown[]) => resolveAcceptedPendingDeliveryMock(...args),
    reconcileAcceptedPendingQueueV2DeliveriesThroughSeq: (...args: unknown[]) => reconcileAcceptedPendingDeliveriesThroughSeqMock(...args),
    blockPendingQueueV2Delivery: (...args: unknown[]) => blockPendingDeliveryMock(...args),
    blockPendingQueueV2ProviderDeliveriesOnAttach: (...args: unknown[]) => blockProviderDeliveriesOnAttachMock(...args),
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer: (...args: unknown[]) => listProviderDeliveryLocalIdsMock(...args),
  };
});

vi.mock('./snapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshotSync')>();
  return {
    ...actual,
    fetchSessionSnapshotUpdateFromServer: (...args: unknown[]) => fetchSnapshotMock(...args),
  };
});

async function createClient(
  sessionOverrides: Record<string, unknown>,
  options: Readonly<{
    sessionSocketEmitWithAck?: NonNullable<Parameters<typeof createApiSessionSocketStub>[0]>['emitWithAck'];
  }> = {},
) {
  sessionSocketStub = createApiSessionSocketStub({
    id: 'session-socket',
    connected: true,
    ...(options.sessionSocketEmitWithAck ? { emitWithAck: options.sessionSocketEmitWithAck } : {}),
  });
  userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
  sessionClientModulePromise ??= import('./sessionClient');
  const { ApiSessionClient } = await sessionClientModulePromise;
  const client = new ApiSessionClient('tok', {
    ...createPlainSessionFixture({ id: 's1' }),
    ...sessionOverrides,
  } as any);
  return client;
}

function triggerCommittedUserMessage(params: Readonly<{
  seq: number;
  localId: string;
  text?: string;
}>): void {
  if (!userSocketStub) throw new Error('Missing user socket stub');
  userSocketStub.trigger('update', {
    id: `update-${params.seq}`,
    createdAt: Date.now(),
    body: {
      t: 'new-message',
      sid: 's1',
      message: {
        id: `m${params.seq}`,
        seq: params.seq,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: params.text ?? `prompt ${params.seq}` },
            localId: params.localId,
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        localId: params.localId,
        messageRole: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function enableProviderAcceptanceMode(client: Awaited<ReturnType<typeof createClient>>): Promise<void> {
  client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
  await waitUntil(() => (client as any).deliveredUserMessageWatermarkDeferredToProviderAcceptance === true);
  await Promise.resolve();
}

type MaterializeOptionsWithDeliveryTiming =
  NonNullable<Parameters<Awaited<ReturnType<typeof createClient>>['materializeNextPendingMessageSafely']>[0]> & {
    pendingQueueDeliveryTiming?: 'after_foreground_ready' | 'after_runtime_idle';
  };

function runtimeIdleMaterializeOptions(
  opts: MaterializeOptionsWithDeliveryTiming = {},
): MaterializeOptionsWithDeliveryTiming {
  return {
    reconcileWhenEmpty: 'force',
    pendingQueueDeliveryTiming: 'after_runtime_idle',
    ...opts,
  };
}

function createPendingDeliveryHttpError(status: number, error: string): Error & {
  isAxiosError: true;
  response: { status: number; data: { error: string } };
} {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: true;
    response: { status: number; data: { error: string } };
  };
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.response = { status, data: { error } };
  return err;
}

describe('ApiSessionClient pending-queue turn-end drain', () => {
  beforeAll(async () => {
    sessionClientModulePromise ??= import('./sessionClient');
    await sessionClientModulePromise;
  }, 120_000);

  beforeEach(() => {
    catchUpMock.mockReset();
    catchUpMock.mockResolvedValue(undefined);
    fetchSnapshotMock.mockReset();
    fetchSnapshotMock.mockResolvedValue({});
    materializeNextMock.mockReset();
    materializeNextMock.mockRejectedValue(new Error('not stubbed'));
    resolveAcceptedPendingDeliveryMock.mockReset();
    resolveAcceptedPendingDeliveryMock.mockResolvedValue({ pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 } });
    reconcileAcceptedPendingDeliveriesThroughSeqMock.mockReset();
    reconcileAcceptedPendingDeliveriesThroughSeqMock.mockResolvedValue({ pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 } });
    blockPendingDeliveryMock.mockReset();
    blockPendingDeliveryMock.mockResolvedValue({});
    blockProviderDeliveriesOnAttachMock.mockReset();
    blockProviderDeliveriesOnAttachMock.mockResolvedValue({});
    listProviderDeliveryLocalIdsMock.mockReset();
    listProviderDeliveryLocalIdsMock.mockResolvedValue([]);
    resolveCliFeatureDecisionForServerMock.mockReset();
    resolveCliFeatureDecisionForServerMock.mockResolvedValue({ decision: createFeatureDecision('enabled') });
    enqueueSessionTurnMock.mockClear();
    enqueueSessionEndMock.mockClear();
    enqueueTranscriptMessageMock.mockClear();
    flushOutboxMock.mockClear();
    closeOutboxMock.mockClear();
    terminalTurnWriteGate = null;
  });

  afterEach(() => {
    terminalTurnWriteGate = null;
    vi.restoreAllMocks();
  });

  it('blocks pending materialization while the snapshot reports an in-progress turn', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('does not attempt materialization when every queued pending row is blocked', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 1,
      pendingVersion: 1,
    });

    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'skip',
    })).resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).not.toHaveBeenCalled();
  });

  it('blocks inherited provider-delivery claims when provider-acceptance mode is enabled', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    blockProviderDeliveriesOnAttachMock.mockResolvedValue({
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 1,
        pendingVersion: 2,
      },
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    await waitUntil(() => blockProviderDeliveriesOnAttachMock.mock.calls.length > 0);
    expect(blockProviderDeliveriesOnAttachMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
    });
    await waitUntil(() => client.shouldAttemptPendingMaterialization() === false);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('retries provider-attach recovery after an initial failure before materializing inherited claims', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    blockProviderDeliveriesOnAttachMock
      .mockRejectedValueOnce(new Error('temporary offline'))
      .mockResolvedValueOnce({
        pendingQueueState: {
          known: true,
          pendingCount: 1,
          pendingBlockedCount: 1,
          pendingVersion: 2,
        },
      });
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      },
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    await waitUntil(() => blockProviderDeliveriesOnAttachMock.mock.calls.length === 1);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({ type: 'no_pending' });

    expect(blockProviderDeliveriesOnAttachMock).toHaveBeenCalledTimes(2);
    expect(materializeNextMock).not.toHaveBeenCalled();
    await waitUntil(() => client.shouldAttemptPendingMaterialization() === false);
  });

  it('allows live-delivery materialization while a canonical turn is active when the caller owns in-flight steer', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
    });
    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'live-steer-local',
      didWrite: true,
      message: {
        id: 'm-live-steer',
        seq: 42,
        localId: 'live-steer-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'steer now' } } },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });

    expect(materializeNextMock).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'materialized',
      localId: 'live-steer-local',
      seq: 42,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'steer now' } } },
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it('keeps default foreground-ready queued materialization eligible while runtime activity is active', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
      runtimeActivityExpiresAt: Date.now() + 60_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'foreground-ready-local',
      didWrite: true,
      message: {
        id: 'm-foreground-ready',
        seq: 43,
        localId: 'foreground-ready-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'queued prompt' } } },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    } satisfies MaterializeOptionsWithDeliveryTiming)).resolves.toMatchObject({
      type: 'materialized',
      localId: 'foreground-ready-local',
    });
    expect(materializeNextMock).toHaveBeenCalled();
  });

  it('defers queued materialization for runtime-idle timing while runtime activity has a valid future expiry', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
      runtimeActivityExpiresAt: Date.now() + 60_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });

    expect(client.shouldAttemptPendingMaterialization(runtimeIdleMaterializeOptions())).toBe(false);
    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'deferred',
      reason: 'runtime_activity_active',
    });
    expect(materializeNextMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null expiry', null],
    ['invalid expiry', Number.NaN],
    ['elapsed expiry', Date.now() - 1],
  ])('fails open for runtime-idle queued materialization when runtime activity has %s', async (_name, expiresAt) => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
      runtimeActivityExpiresAt: expiresAt,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    expect(client.shouldAttemptPendingMaterialization(runtimeIdleMaterializeOptions())).toBe(true);
    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'no_pending',
    });
    expect(materializeNextMock).toHaveBeenCalled();
  });

  it('passes runtime-idle delivery timing to server materialization when locally eligible', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: null,
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'no_pending',
    });
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryTiming: 'after_runtime_idle',
    }));
  });

  it('does not use a fixed max wait cap while renewed runtime activity expiry remains future-valid', async () => {
    const now = Date.now();
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: now + 3_600_000,
      runtimeActivityExpiresAt: now + 7_200_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });

    expect(client.shouldAttemptPendingMaterialization(runtimeIdleMaterializeOptions())).toBe(false);
    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'deferred',
      reason: 'runtime_activity_active',
    });
    expect(materializeNextMock).not.toHaveBeenCalled();
  });

  it('uses locally acknowledged runtime activity projection for runtime-idle queued materialization before server echo even after public expiry elapses', async () => {
    const now = Date.now();
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: null,
    }, {
      sessionSocketEmitWithAck: async (event: string) => event === 'update-runtime-activity'
        ? { result: 'success' }
        : { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });

    await client.updateRuntimeActivityProjection({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: now - 180_000,
      runtimeActivityExpiresAt: now - 60_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });

    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    expect(client.shouldAttemptPendingMaterialization(runtimeIdleMaterializeOptions())).toBe(true);
    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'no_pending',
    });
    expect(materializeNextMock).toHaveBeenCalled();
  });

  it.each([
    {
      name: 'canonical active turn',
      sessionOverrides: {
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      },
      prepare: async (client: Awaited<ReturnType<typeof createClient>>) => {
        await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
      },
    },
    {
      name: 'durable active latest turn',
      sessionOverrides: {
        latestTurnStatus: 'in_progress',
        pendingCount: 1,
        pendingVersion: 1,
      },
      prepare: async () => {},
    },
    {
      name: 'continuation recovery',
      sessionOverrides: {
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
        metadata: {
          sessionContinuationRecoveryV1: {
            v: 1,
            attemptsById: {
              'generation-1:restart-1': {
                v: 1,
                attemptId: 'generation-1:restart-1',
                status: 'pending_provider_context',
                failureAtMs: 100,
                updatedAtMs: 110,
                resumePromptMode: 'standard',
              },
            },
          },
        },
      },
      prepare: async () => {},
    },
  ])('pending materialization RPC respects the $name drain guard', async ({ sessionOverrides, prepare }) => {
    const client = await createClient(sessionOverrides);
    await prepare(client);

    const result = await client.rpcHandlerManager.invokeLocal('session.pendingQueue.materializeNext', {
      reconcileWhenEmpty: 'force',
    });

    expect(result).toEqual({
      ok: true,
      didMaterialize: false,
      result: { type: 'no_pending' },
    });
    expect(materializeNextMock).not.toHaveBeenCalled();
  });

  it('canonical turn completion clears a stale in-progress snapshot status and unblocks materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('canonical turn cancellation also unblocks materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    await client.sessionTurnLifecycle.cancelTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('wakes pending consumers on turn completion (metadata-updated)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });

    let woke = 0;
    client.on('metadata-updated', () => {
      woke += 1;
    });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    expect(woke).toBeGreaterThanOrEqual(1);
  });

  it('reconciles a stale-empty pending count on turn completion (lost-nudge recovery)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    fetchSnapshotMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSnapshotMock).toHaveBeenCalled();
  });

  it('reports pending queue reconciliation changes when only the blocked count changes', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
    fetchSnapshotMock.mockResolvedValueOnce({
      pendingQueueState: {
        known: true,
        pendingCount: 2,
        pendingBlockedCount: 1,
        pendingVersion: 7,
      },
    });

    await expect(client.reconcilePendingQueueState({ force: true })).resolves.toBe(true);
  });

  it('replays owed user transcript rows at turn end (missed-broadcast recovery)', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 0 }));
  });

  it('does not replay a same-process provider-accepted user row when durable metadata is stale', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
      metadata: { deliveredUserMessageSeqV1: 737 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    triggerCommittedUserMessage({ seq: 739, localId: 'prompt-739' });
    client.confirmUserMessageDeliveredToProvider(739, { localIds: ['prompt-739'] });

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 739 })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['prompt-739'] })).toBe(true);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 739 }));
  });

  it('reconciles restart-stranded provider delivery rows from the durable accepted watermark before materializing', async () => {
    const client = await createClient({
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 42, providerAcceptedUserMessageSeqV1: 42 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    const result = await client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
    });

    expect(reconcileAcceptedPendingDeliveriesThroughSeqMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      maxAcceptedSeq: 42,
    });
    expect(materializeNextMock).not.toHaveBeenCalled();
    expect(result).toEqual({ type: 'no_pending' });
  });

  it('uses legacy pending materialization until provider acceptance custody is enabled', async () => {
    const client = await createClient({
      pendingCount: 1,
      pendingVersion: 1,
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      localId: null,
      didWrite: false,
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });

    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStateOptIn: false,
    }));
  });

  it('requests provider delivery state after provider acceptance custody is enabled', async () => {
    const client = await createClient({
      pendingCount: 1,
      pendingVersion: 1,
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      localId: null,
      didWrite: false,
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });

    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStateOptIn: true,
    }));
  });

  it('reconciles stale provider-delivery rows through the legacy delivered cursor before legacy materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingVersion: 30,
      metadata: { deliveredUserMessageSeqV1: 1809 },
    });
    reconcileAcceptedPendingDeliveriesThroughSeqMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 31 },
    });
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'legacy-next-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 32 },
      message: {
        id: 'm-legacy-next',
        seq: 1810,
        localId: 'legacy-next-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'next prompt after stale row' },
            localId: 'legacy-next-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1001,
        updatedAt: 1001,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });

    expect(reconcileAcceptedPendingDeliveriesThroughSeqMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      maxAcceptedSeq: 1809,
    });
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStateOptIn: false,
    }));
    expect(result).toMatchObject({
      type: 'materialized',
      localId: 'legacy-next-local',
      seq: 1810,
    });
  });

  it('does not persist a volatile handoff-only seq when a lower provider-accepted seq is confirmed', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
      metadata: { deliveredUserMessageSeqV1: 737 },
    });
    await enableProviderAcceptanceMode(client);
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as any).metadata = metadata;
    });
    const received: unknown[] = [];
    client.onUserMessage((message) => {
      received.push(message);
    });

    triggerCommittedUserMessage({ seq: 740, localId: 'prompt-handoff-only-740' });
    expect(received).toHaveLength(1);
    expect(updateMetadata).not.toHaveBeenCalled();
    client.confirmUserMessageDeliveredToProvider(739);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(metadata).toEqual(expect.objectContaining({
      deliveredUserMessageSeqV1: 739,
      providerAcceptedUserMessageSeqV1: 739,
    }));
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 739 })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 740 })).toBe(false);
  });

  it('recognizes provider acceptance joined by local id before the committed seq exists', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
      metadata: { deliveredUserMessageSeqV1: 737 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['prompt-late-seq'] });

    expect(client.hasUserMessageProviderAcceptance({ localIds: ['prompt-late-seq'] })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 740 })).toBe(false);

    triggerCommittedUserMessage({ seq: 740, localId: 'prompt-late-seq' });

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 740 })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeqs: [740] })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeqs: [740, 741] })).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({
      userMessageSeqs: [740, 741],
      localIds: ['prompt-late-seq'],
    })).toBe(false);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 740 }));
  });

  it('does not treat deliveredUserMessageSeqV1 as provider custody when provider acceptance owns delivery proof', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
      metadata: { deliveredUserMessageSeqV1: 100 },
    });
    await enableProviderAcceptanceMode(client);

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 100 })).toBe(false);
    client.confirmUserMessageDeliveredToProvider(100);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 100 })).toBe(true);
  });

  it('preserves old-server queue-handoff behavior and does not call delivery-state routes without materialize support', async () => {
    resolveCliFeatureDecisionForServerMock.mockResolvedValueOnce({
      decision: createFeatureDecision('unsupported'),
    });
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'old-server-local',
      didWrite: true,
      pendingQueueState: { pendingCount: 0, pendingVersion: 2 },
      message: {
        id: 'm-old-server',
        seq: 42,
        localId: 'old-server-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'old server prompt' },
            localId: 'old-server-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(resolveCliFeatureDecisionForServerMock).toHaveBeenCalledWith(expect.objectContaining({
      featureId: 'sharing.pendingDeliveryState',
    }));
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStateOptIn: false,
    }));
    expect(result).toEqual({
      type: 'materialized',
      localId: 'old-server-local',
      seq: 42,
      content: {
        t: 'plain',
        v: {
          role: 'user',
          content: { type: 'text', text: 'old server prompt' },
          localId: 'old-server-local',
          meta: { source: 'ui', sentFrom: 'web' },
        },
      },
      createdAt: 1000,
      updatedAt: 1000,
    });

    client.confirmUserMessageDeliveredToProvider(42, { localIds: ['old-server-local'] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 42 })).toBe(true);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
    expect(blockProviderDeliveriesOnAttachMock).not.toHaveBeenCalled();
  });

  it('resolves server-owned provider delivery after provider acceptance', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'new-server-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-new-server',
        seq: 43,
        localId: 'new-server-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'new server prompt' },
            localId: 'new-server-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect((result as any).deliveryState).toEqual(deliveryState);

    client.confirmUserMessageDeliveredToProvider(43, { localIds: ['new-server-local'] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'new-server-local',
    });
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 43 })).toBe(true);
  });

  it('does not persist provider watermark before server-owned accepted delivery resolves', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await enableProviderAcceptanceMode(client);
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as any).metadata = metadata;
    });
    resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(new Error('temporary accepted-delivery resolution failure'));
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'watermark-held-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-watermark-held',
        seq: 43,
        localId: 'watermark-held-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'watermark held prompt' },
            localId: 'watermark-held-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'watermark-held-local',
      deliveryState,
    });

    client.confirmUserMessageDeliveredToProvider(43, { localIds: ['watermark-held-local'] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(metadata).not.toEqual(expect.objectContaining({
      providerAcceptedUserMessageSeqV1: 43,
    }));

    (client as any).recordCommittedUserMessageSeq('watermark-held-local', 43);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateMetadata).not.toHaveBeenCalled();
    expect(metadata).not.toEqual(expect.objectContaining({
      providerAcceptedUserMessageSeqV1: 43,
    }));
  });

  it('delivers provider-claimed pending rows directly without a committed transcript seq', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'claimed-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'claimed-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'claimed-provider-local',
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt' },
          localId: 'claimed-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();

    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as any).metadata = metadata;
    });
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
      message: {
        id: 'm-claimed-provider-local',
        seq: 43,
        localId: 'claimed-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1001,
        updatedAt: 1001,
      },
    });

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['claimed-provider-local'] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'claimed-provider-local',
    });
    await waitUntil(() => updateMetadata.mock.calls.length > 0);
    expect(metadata).toEqual(expect.objectContaining({
      deliveredUserMessageSeqV1: 43,
      providerAcceptedUserMessageSeqV1: 43,
    }));
  });

  it('waits for in-flight accepted pending-delivery resolution before closing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-drain-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-drain-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before close' },
            localId: 'close-drain-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-drain-provider-local',
      deliveryState,
    });

    const acceptedWrite = createDeferred<void>();
    resolveAcceptedPendingDeliveryMock.mockImplementationOnce(async () => {
      await acceptedWrite.promise;
      return {
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
        message: {
          id: 'm-close-drain-provider-local',
          seq: 43,
          localId: 'close-drain-provider-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'claimed provider prompt before close' },
              localId: 'close-drain-provider-local',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      };
    });

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['close-drain-provider-local'] });
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    (client as any).rpcLifecycleRegistrations.splice(0);

    let closeSettled = false;
    const closePromise = client.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeSettled).toBe(false);

    acceptedWrite.resolve();
    await closePromise;
    expect(closeSettled).toBe(true);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('does not block provider-accepted pending delivery on close when accepted resolution is still failing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-accepted-retry-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-accepted-retry-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'accepted prompt with temporary resolution failure' },
            localId: 'close-accepted-retry-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary accepted resolution failure'))
      .mockRejectedValueOnce(new Error('still temporarily unavailable'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-accepted-retry-local',
      deliveryState,
    });

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['close-accepted-retry-local'] });
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    (client as any).rpcLifecycleRegistrations.splice(0);

    await client.close();

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('blocks unresolved provider-claimed pending deliveries before closing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-block-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before runner exit' },
            localId: 'close-block-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-provider-local',
      deliveryState,
    });

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('blocks unresolved provider-custody rows discovered from durable state during close', async () => {
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await waitUntil(() => blockProviderDeliveriesOnAttachMock.mock.calls.length === 1);
    listProviderDeliveryLocalIdsMock.mockResolvedValueOnce(['close-durable-provider-local']);
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 1,
        pendingVersion: 2,
      },
    });

    try {
      await client.close();

      expect(listProviderDeliveryLocalIdsMock).toHaveBeenCalledWith({
        token: 'tok',
        sessionId: 's1',
      });
      expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
        token: 'tok',
        sessionId: 's1',
        localId: 'close-durable-provider-local',
        reason: 'runtime_disposed_before_delivery',
      });
      expect(debugSpy.mock.calls.some(([message, payload]) =>
        String(message) === '[pendingQueue] provider delivery block succeeded'
        && (payload as any)?.sessionId === 's1'
        && (payload as any)?.localId === 'close-durable-provider-local'
        && (payload as any)?.reason === 'runtime_disposed_before_delivery'
      )).toBe(true);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('blocks delivered provider-claimed pending rows before closing when materialization omits delivery state', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-legacy-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-block-legacy-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before dispatch proof' },
            localId: 'close-block-legacy-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-legacy-provider-local',
      seq: null,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt before dispatch proof' },
          localId: 'close-block-legacy-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-legacy-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('blocks delivered uncommitted provider-claimed pending rows whose materialization includes an opaque id', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-opaque-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'opaque-pending-materialization-id',
        seq: null,
        localId: 'close-block-opaque-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with opaque id before dispatch proof' },
            localId: 'close-block-opaque-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-opaque-provider-local',
      seq: null,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with opaque id before dispatch proof' },
          localId: 'close-block-opaque-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-opaque-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('normalizes contradictory resolved provider state on delivered uncommitted provider claims', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-resolved-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'opaque-resolved-provider-materialization-id',
        seq: null,
        localId: 'close-block-resolved-provider-local',
        messageRole: 'user',
        deliveryState: { mode: 'provider' as const, unresolved: false },
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with stale resolved state' },
            localId: 'close-block-resolved-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const normalizedDeliveryState = { mode: 'provider', unresolved: true };
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-resolved-provider-local',
      seq: null,
      deliveryState: normalizedDeliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with stale resolved state' },
          localId: 'close-block-resolved-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-resolved-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('uses the materialization ack localId for provider-claimed rows whose nested message omits it', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'top-level-claimed-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: null,
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'top-level-claimed-provider-local',
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
          localId: 'top-level-claimed-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
      message: {
        id: 'm-top-level-claimed-provider-local',
        seq: 44,
        localId: 'top-level-claimed-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
            localId: 'top-level-claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1001,
        updatedAt: 1001,
      },
    });

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['top-level-claimed-provider-local'] });
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'top-level-claimed-provider-local',
    });
    await waitUntil(() => client.hasUserMessageProviderAcceptance({ userMessageSeq: 44 }));
  });

  it('blocks malformed provider-delivery materialization metadata instead of dropping the row locally', async () => {
    const localId = 'malformed-provider-delivery-local';
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    const delivered: unknown[] = [];
    client.onUserMessage((message) => delivered.push(message));
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId,
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId,
        messageRole: 'user',
        deliveryStateMalformed: true,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'malformed provider delivery metadata prompt' },
            localId,
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(delivered).toEqual([]);
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId,
      reason: 'unknown',
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('delivers encrypted provider-claimed pending rows even when server role metadata is missing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const localId = 'encrypted-claimed-provider-local';
    const encryptionKey = new Uint8Array(32);
    const client = await createClient({
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId,
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId,
        messageRole: null,
        deliveryState,
        content: {
          t: 'encrypted',
          c: encodeBase64(encrypt(encryptionKey, 'legacy', {
            role: 'user',
            content: { type: 'text', text: 'encrypted claimed provider prompt' },
            localId,
            meta: { source: 'ui', sentFrom: 'web' },
          })),
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'encrypted claimed provider prompt' },
          localId,
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('clears accepted canonical pending delivery so later pending rows can materialize', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-provider-1',
          seq: 51,
          localId: 'provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first prompt' },
              localId: 'provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-provider-2',
          seq: 52,
          localId: 'provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'second prompt' },
              localId: 'provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-m1',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    client.confirmUserMessageDeliveredToProvider(51, { localIds: ['provider-m1'] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-m2',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('clears aggregate accepted canonical pending delivery local ids before materializing later rows', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    reconcileAcceptedPendingDeliveriesThroughSeqMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
      resolvedLocalIds: ['provider-through-seq-m1'],
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'provider-through-seq-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-provider-through-seq-1',
          seq: 81,
          localId: 'provider-through-seq-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first aggregate accepted prompt' },
              localId: 'provider-through-seq-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'provider-through-seq-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-provider-through-seq-2',
          seq: 82,
          localId: 'provider-through-seq-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'second aggregate accepted prompt' },
              localId: 'provider-through-seq-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-through-seq-m1',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    client.confirmUserMessageDeliveredToProvider(81);
    await Promise.resolve();

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-through-seq-m2',
    });
    expect(reconcileAcceptedPendingDeliveriesThroughSeqMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      maxAcceptedSeq: 81,
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retries failed accepted-delivery resolution before blocking later pending materialization', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary resolution failure'))
      .mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
      });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-retry-provider-1',
          seq: 61,
          localId: 'retry-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first retry prompt' },
              localId: 'retry-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-retry-provider-2',
          seq: 62,
          localId: 'retry-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'second retry prompt' },
              localId: 'retry-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'retry-provider-m1',
      deliveryState,
    });

    client.confirmUserMessageDeliveredToProvider(61, { localIds: ['retry-provider-m1'] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'retry-provider-m2',
    });
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retires a stale accepted-delivery claim when the server reports that the pending row is gone', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    resolveAcceptedPendingDeliveryMock.mockRejectedValue(createPendingDeliveryHttpError(404, 'not-found'));
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-accepted-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-stale-accepted-provider-1',
          seq: 71,
          localId: 'stale-accepted-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first stale accepted prompt' },
              localId: 'stale-accepted-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-accepted-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-stale-accepted-provider-2',
          seq: 72,
          localId: 'stale-accepted-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after stale accepted claim' },
              localId: 'stale-accepted-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'stale-accepted-provider-m1',
      deliveryState,
    });

    client.confirmUserMessageDeliveredToProvider(71, { localIds: ['stale-accepted-provider-m1'] });
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'stale-accepted-provider-m2',
    });
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('blocks server-owned provider delivery after a terminal pre-write payload rejection', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'too-large-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-too-large-provider-1',
          seq: 71,
          localId: 'too-large-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'oversized prompt' },
              localId: 'too-large-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'too-large-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-too-large-provider-2',
          seq: 72,
          localId: 'too-large-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt' },
              localId: 'too-large-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'too-large-provider-m1',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await expect(client.blockPendingMessageDelivery({
      localIds: ['too-large-provider-m1'],
      reason: 'payload_too_large',
    })).resolves.toBe(true);

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'too-large-provider-m1',
      reason: 'payload_too_large',
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'too-large-provider-m2',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('claims a server-owned provider delivery block locally when the server block write will retry', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    blockPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary block failure'))
      .mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
      });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-block-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-retry-block-provider-1',
          seq: 81,
          localId: 'retry-block-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'provider prompt to block' },
              localId: 'retry-block-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-block-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-retry-block-provider-2',
          seq: 82,
          localId: 'retry-block-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after block retry' },
              localId: 'retry-block-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'retry-block-provider-m1',
      deliveryState,
    });

    await expect(client.blockPendingMessageDelivery({
      localIds: ['retry-block-provider-m1'],
      reason: 'runtime_disposed_before_delivery',
    })).resolves.toBe(true);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'retry-block-provider-m2',
    });
    expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retires a stale blocked-delivery claim when the server reports that the pending row is gone', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    reconcileAcceptedPendingDeliveriesThroughSeqMock.mockResolvedValue({
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
    });
    blockPendingDeliveryMock.mockRejectedValue(createPendingDeliveryHttpError(404, 'not-found'));
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-block-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-stale-block-provider-1',
          seq: 81,
          localId: 'stale-block-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'provider prompt whose block is stale' },
              localId: 'stale-block-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-block-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-stale-block-provider-2',
          seq: 82,
          localId: 'stale-block-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after stale block claim' },
              localId: 'stale-block-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'stale-block-provider-m1',
      deliveryState,
    });

    await expect(client.blockPendingMessageDelivery({
      localIds: ['stale-block-provider-m1'],
      reason: 'runtime_disposed_before_delivery',
    })).resolves.toBe(false);
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);

    const secondResult = await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    expect(secondResult).toMatchObject({
      type: 'materialized',
      localId: 'stale-block-provider-m2',
    });
    expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retries failed canonical block writes during popPendingMessage before draining later rows', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    blockPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary block failure'))
      .mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
      });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-block-pop-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-retry-block-pop-provider-1',
          seq: 91,
          localId: 'retry-block-pop-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'provider prompt to retry during pop' },
              localId: 'retry-block-pop-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-block-pop-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-retry-block-pop-provider-2',
          seq: 92,
          localId: 'retry-block-pop-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after pop retry' },
              localId: 'retry-block-pop-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'retry-block-pop-provider-m1',
      deliveryState,
    });

    await expect(client.blockPendingMessageDelivery({
      localIds: ['retry-block-pop-provider-m1'],
      reason: 'runtime_disposed_before_delivery',
    })).resolves.toBe(true);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await expect(client.popPendingMessage()).resolves.toBe(true);
    expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('does not use turn-end catch-up as a hidden transcript queue for canonical pending deliveries', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    const delivered: unknown[] = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'canonical-pending-local',
      didWrite: true,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-canonical-pending',
        seq: 44,
        localId: 'canonical-pending-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'canonical pending prompt' },
            localId: 'canonical-pending-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(delivered).toHaveLength(1);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).not.toHaveBeenCalled();
  });

  it('does not loop materializing the same queued provider-delivery localId while it remains unresolved', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'repeat-provider-local',
      didWrite: false,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-repeat-provider',
        seq: 45,
        localId: 'repeat-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'repeat provider prompt' },
            localId: 'repeat-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'repeat-provider-local',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('tracks provider-claimed materialized localIds for provider-acceptance cleanup', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: unknown[] = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'provider-claim-local',
      didWrite: false,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-provider-claim',
        seq: null,
        localId: 'provider-claim-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'provider-claim-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-claim-local',
      seq: null,
      deliveryState,
    });

    expect(delivered).toHaveLength(1);
    expect(
      (client as unknown as { hasPendingQueueMaterializedLocalId(localId: string): boolean })
        .hasPendingQueueMaterializedLocalId('provider-claim-local'),
    ).toBe(true);
  });

  it('waits for terminal turn writes to settle before turn-end owed catch-up', async () => {
    const terminalWrite = createDeferred<void>();
    terminalTurnWriteGate = terminalWrite;
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();

    const completion = client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(enqueueSessionTurnMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'complete' }));
    expect(catchUpMock).not.toHaveBeenCalled();

    terminalWrite.resolve();
    await completion;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 0 }));
  });

  it('still materializes while the session socket supervisor is reconnecting (HTTP fallback transport)', async () => {
    supervisorPhase = 'connecting';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });
      materializeNextMock.mockResolvedValue({ didMaterialize: false });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result.type).not.toBe('deferred');
      expect(materializeNextMock).toHaveBeenCalled();
    } finally {
      supervisorPhase = 'online';
    }
  });

  it('defers materialization while the supervisor is auth_failed', async () => {
    supervisorPhase = 'auth_failed';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result).toEqual({ type: 'deferred', reason: 'supervisor_auth_failed' });
      expect(materializeNextMock).not.toHaveBeenCalled();
    } finally {
      supervisorPhase = 'online';
    }
  });

  it('self-heals a stale in-progress snapshot status with no canonical active turn during materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    // No canonical turn ever began locally (e.g. respawned runner); the server has
    // since completed the turn, so a refresh must clear the stale block and let the
    // materialize attempt reach the server within the same wake.
    fetchSnapshotMock.mockResolvedValue({ latestTurnStatus: 'completed' });
    materializeNextMock.mockResolvedValue({ didMaterialize: false });

    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await client.materializeNextPendingMessageSafely();
    expect(fetchSnapshotMock).toHaveBeenCalled();
    expect(materializeNextMock).toHaveBeenCalled();
  });
});
