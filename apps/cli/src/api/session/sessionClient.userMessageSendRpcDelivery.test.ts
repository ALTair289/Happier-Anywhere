import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY } from '@happier-dev/protocol';

import { createMockSession, createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, flushApiSessionClientMessageCommitQueue, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { waitForCondition } from '@/testkit/async/waitFor';
import { decodeBase64, decrypt } from '../encryption';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

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

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
    getState: () => ({ phase: 'online' }),
  }),
}));

const {
  blockPendingQueueV2ProviderDeliveriesOnAttachMock,
  enqueuePendingQueueV2MessageViaHttpMock,
  materializeNextPendingQueueV2MessageMock,
  resolveCliFeatureDecisionForServerMock,
} = vi.hoisted(() => ({
  blockPendingQueueV2ProviderDeliveriesOnAttachMock: vi.fn(),
  enqueuePendingQueueV2MessageViaHttpMock: vi.fn(),
  materializeNextPendingQueueV2MessageMock: vi.fn(),
  resolveCliFeatureDecisionForServerMock: vi.fn(),
}));

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
    blockPendingQueueV2ProviderDeliveriesOnAttach: (...args: unknown[]) => blockPendingQueueV2ProviderDeliveriesOnAttachMock(...args),
    enqueuePendingQueueV2MessageViaHttp: (...args: unknown[]) => enqueuePendingQueueV2MessageViaHttpMock(...args),
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextPendingQueueV2MessageMock(...args),
  };
});

import { ApiSessionClient } from './sessionClient';

function createPendingDeliveryStateFeatureDecision(state: 'enabled' | 'unsupported' = 'enabled') {
  return {
    featureId: 'sharing.pendingDeliveryState',
    state,
    evaluatedAt: Date.now(),
    scope: { scopeKind: 'runtime' },
    diagnostics: [],
  };
}

async function enableProviderAcceptanceMode(client: ApiSessionClient): Promise<void> {
  client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
  await waitForCondition(
    () => (client as any).deliveredUserMessageWatermarkDeferredToProviderAcceptance === true,
    { timeoutMs: 1_000, intervalMs: 5, label: 'provider acceptance mode activation' },
  );
  await Promise.resolve();
}

describe('ApiSessionClient session.userMessage.send delivery', () => {
  beforeEach(() => {
    resolveCliFeatureDecisionForServerMock.mockReset();
    resolveCliFeatureDecisionForServerMock.mockResolvedValue({
      decision: createPendingDeliveryStateFeatureDecision('enabled'),
    });
    blockPendingQueueV2ProviderDeliveriesOnAttachMock.mockReset();
    blockPendingQueueV2ProviderDeliveriesOnAttachMock.mockResolvedValue({});
    enqueuePendingQueueV2MessageViaHttpMock.mockReset();
    enqueuePendingQueueV2MessageViaHttpMock.mockResolvedValue(undefined);
    materializeNextPendingQueueV2MessageMock.mockReset();
    materializeNextPendingQueueV2MessageMock.mockResolvedValue({
      didMaterialize: false,
      localId: null,
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 },
    });
  });

  it('holds explicit server-pending materialized rows during active turns until authorized catch-up', () => {
    const client = Object.create(ApiSessionClient.prototype) as any;
    client.sessionId = 's1';
    client.latestTurnStatus = 'in_progress';
    client.userMessageCallbackAttachedAtMs = null;
    client.canonicalPendingDeliveryByLocalId = new Map();

    const message = {
      role: 'user',
      content: { type: 'text', text: 'queue after turn' },
      localId: 'pending-local',
      meta: {
        source: 'ui',
        [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: 'explicit_pending',
      },
      createdAt: Date.now(),
    };
    const update = {
      id: 'u-explicit-pending',
      body: {
        t: 'new-message',
        message: { seq: 11 },
      },
    };

    expect(client.shouldDeliverUserMessageToAgentQueueFromUpdate(message, update, {})).toBe(false);
    expect(client.shouldDeliverUserMessageToAgentQueueFromUpdate(message, {
      ...update,
      id: 'catchup-explicit-pending',
    }, {
      catchUpAfterSeq: 10,
      catchUpAuthorization: 'explicit_cursor',
    })).toBe(true);
  });

  it('delivers the prompt to the agent queue eagerly and suppresses later transcript echo updates', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    // Simulate the daemon/UI invoking the session-scoped RPC handler, which calls the internal enqueue.
    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.type).toBe('text');
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
  });

  it('delivers fresh direct prompts while runtime activity projection is active', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm-runtime-active', seq: 1, localId: 'fresh-runtime-active' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const session = createPlainSessionFixture({
      id: 's1',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
      runtimeActivityExpiresAt: Date.now() + 60_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    } as Parameters<typeof createPlainSessionFixture>[0] & {
      runtimeActivityActiveCount: number;
      runtimeActivityObservedAt: number;
      runtimeActivityExpiresAt: number;
      runtimeActivitySourceClass: 'provider_detached_task';
    });
    const client = new ApiSessionClient('tok', session);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'fresh while background runtime is active',
      localId: 'fresh-runtime-active',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('fresh while background runtime is active');
    expect(materializeNextPendingQueueV2MessageMock).not.toHaveBeenCalled();
  });

  it('suppresses a transcript echo that arrives reentrantly during eager RPC prompt delivery', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    let triggeredEcho = false;
    client.onUserMessage((msg) => {
      received.push(msg);
      if (triggeredEcho) return;
      triggeredEcho = true;
      sessionSocketStub?.trigger('update', {
        id: 'u1',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                localId: 'l1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'l1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('refreshes echo suppression when the local user-message commit is acknowledged before a delayed transcript echo', async () => {
    vi.useFakeTimers();
    try {
      let resolveMessageAck: (() => void) | null = null;
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAck: async (event) => {
          if (event !== 'message') {
            return { ok: true };
          }
          await new Promise<void>((resolve) => {
            resolveMessageAck = resolve;
          });
          return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
        },
      });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      const received: any[] = [];
      client.onUserMessage((msg) => received.push(msg));

      await (client as any).enqueueSessionUserMessage({
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'ios' },
      });
      expect(received).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(8_000);
      const releaseAck = ((release: (() => void) | null): (() => void) => {
        if (typeof release !== 'function') {
          throw new Error('expected delayed message ack to be pending');
        }
        return release;
      })(resolveMessageAck);
      releaseAck();
      await flushApiSessionClientMessageCommitQueue(client as any);

      sessionSocketStub.trigger('update', {
        id: 'u1',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                localId: 'l1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'l1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });

      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not advance the delivered watermark from a transcript echo while provider acceptance owns delivery proof', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'update-metadata') {
          return { result: 'success', version: 1, metadata: (payload as { metadata?: unknown })?.metadata };
        }
        return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await enableProviderAcceptanceMode(client);
    await waitForCondition(
      () => client.getMetadataSnapshot()?.userMessageDeliveryWatermarkModeV1 === 'providerAcceptance',
      { timeoutMs: 1_000, intervalMs: 5, label: 'provider acceptance watermark mode persistence' },
    );

    client.sendUserTextMessage('hello', {
      localId: 'l1',
      meta: { source: 'cli', sentFrom: 'cli' },
    });

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'cli', sentFrom: 'cli' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(client.getMetadataSnapshot()?.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);

    client.confirmUserMessageDeliveredToProvider(1);

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(true);
  });

  it('routes provider-acceptance RPC prompts through the server pending claim instead of committing a transcript row', async () => {
    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);
    const committedPayloads: unknown[] = [];
    let pendingContent: unknown = null;

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          committedPayloads.push(payload);
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    enqueuePendingQueueV2MessageViaHttpMock.mockImplementationOnce(async (params: any) => {
      const body = params?.body;
      pendingContent = typeof body?.ciphertext === 'string'
        ? { t: 'encrypted', c: body.ciphertext }
        : body?.content ?? null;
    });
    materializeNextPendingQueueV2MessageMock.mockImplementationOnce(async () => ({
      didMaterialize: true,
      localId: 'l1',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'l1',
        messageRole: null,
        content: pendingContent,
        createdAt: 1_000,
        updatedAt: 1_000,
        deliveryState: { mode: 'provider', unresolved: true },
      },
    }));

    const client = new ApiSessionClient('tok', createMockSession({
      id: 's1',
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }) as any);
    await enableProviderAcceptanceMode(client);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello from provider claim',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'web' },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    const enqueueParams = enqueuePendingQueueV2MessageViaHttpMock.mock.calls[0]?.[0] as any;
    expect(enqueueParams?.sessionId).toBe('s1');
    expect(enqueueParams?.body?.localId).toBe('l1');
    expect(enqueueParams?.body?.messageRole).toBe('user');
    expect(typeof enqueueParams?.body?.ciphertext).toBe('string');
    const decoded = decrypt(encryptionKey, 'legacy', decodeBase64(enqueueParams.body.ciphertext));
    expect(decoded).toMatchObject({
      role: 'user',
      content: { type: 'text', text: 'hello from provider claim' },
      meta: { source: 'ui', sentFrom: 'web' },
    });
    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      deliveryStateOptIn: true,
    }));
    expect(received).toHaveLength(1);
    expect(received[0]?.localId).toBe('l1');
    expect(received[0]?.content?.text).toBe('hello from provider claim');
    expect(committedPayloads).toHaveLength(0);
  });

  it('reports provider-acceptance pending custody in the session user-message RPC ACK', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }));
    await enableProviderAcceptanceMode(client);

    const result = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
      text: 'send now with durable custody',
      localId: 'rpc-provider-acceptance-local',
      meta: { source: 'ui', sentFrom: 'web' },
    });

    expect(result).toEqual({ ok: true, providerAcceptancePending: true });
    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    expect(enqueuePendingQueueV2MessageViaHttpMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      body: expect.objectContaining({
        localId: 'rpc-provider-acceptance-local',
        messageRole: 'user',
      }),
    }));
  });

  it('does not materialize a provider-acceptance RPC prompt while an earlier canonical delivery is unresolved', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }));
    await enableProviderAcceptanceMode(client);

    (client as any).canonicalPendingDeliveryByLocalId.set('earlier-local', {
      mode: 'provider',
      unresolved: true,
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'later send now',
      localId: 'later-local',
      meta: { source: 'ui', sentFrom: 'web' },
    });

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingQueueV2MessageMock).not.toHaveBeenCalled();
  });

  it('materializes a provider-acceptance RPC prompt immediately when no canonical delivery is unresolved', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    materializeNextPendingQueueV2MessageMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'send-now-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'send-now-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send now' } } },
        createdAt: 1_000,
        updatedAt: 1_000,
        deliveryState: { mode: 'provider', unresolved: true },
      },
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }));
    await enableProviderAcceptanceMode(client);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'send now',
      localId: 'send-now-local',
      meta: { source: 'ui', sentFrom: 'web' },
    });

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      deliveryStateOptIn: true,
    }));
    expect(received).toHaveLength(1);
    expect(received[0]?.localId).toBe('send-now-local');
  });

  it('can defer the provider-accepted watermark without claiming pending delivery state', async () => {
    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(8);
    let pendingContent: unknown = null;

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'update-metadata') {
          return { result: 'success', version: 1, metadata: (payload as { metadata?: unknown })?.metadata };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    enqueuePendingQueueV2MessageViaHttpMock.mockImplementationOnce(async (params: any) => {
      const body = params?.body;
      pendingContent = typeof body?.ciphertext === 'string'
        ? { t: 'encrypted', c: body.ciphertext }
        : body?.content ?? null;
    });
    materializeNextPendingQueueV2MessageMock.mockImplementationOnce(async () => ({
      didMaterialize: true,
      localId: 'l1',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: 'm1',
        seq: 1,
        localId: 'l1',
        messageRole: 'user',
        content: pendingContent,
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    }));

    const client = new ApiSessionClient('tok', createMockSession({
      id: 's1',
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }) as any);
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance({
      pendingMaterialization: 'commitAtMaterialize',
    });
    await waitForCondition(
      () => (client as any).deliveredUserMessageWatermarkDeferredToProviderAcceptance === true,
      { timeoutMs: 1_000, intervalMs: 5, label: 'provider acceptance watermark-only mode activation' },
    );

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello from provider-accepted commit path',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'web' },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(resolveCliFeatureDecisionForServerMock).not.toHaveBeenCalled();
    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      deliveryStateOptIn: false,
    }));
    expect(received).toHaveLength(1);
    expect(received[0]?.localId).toBe('l1');
    expect(received[0]?.content?.text).toBe('hello from provider-accepted commit path');
    expect(client.getMetadataSnapshot()?.deliveredUserMessageSeqV1).toBeUndefined();

    client.confirmUserMessageDeliveredToProvider(1);
    await waitForCondition(
      () => client.getMetadataSnapshot()?.deliveredUserMessageSeqV1 === 1,
      { timeoutMs: 1_000, intervalMs: 5, label: 'provider accepted commit watermark persistence' },
    );
  });

  it('keeps provider-acceptance RPC prompts durable when delivery-state claims are unsupported', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    resolveCliFeatureDecisionForServerMock.mockResolvedValueOnce({
      decision: createPendingDeliveryStateFeatureDecision('unsupported'),
    });
    materializeNextPendingQueueV2MessageMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'unsupported-claim-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: 'm-unsupported-claim',
        seq: 7,
        localId: 'unsupported-claim-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'durable unsupported claim fallback' },
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'durable unsupported claim fallback',
      localId: 'unsupported-claim-local',
      meta: { source: 'ui', sentFrom: 'web' },
    });

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      deliveryStateOptIn: false,
    }));
    expect(received).toHaveLength(1);
    expect(received[0]?.localId).toBe('unsupported-claim-local');
  });

  it('delivers row-first unresolved daemon initial prompts through provider delivery instead of echo suppression', async () => {
    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(9);
    const committedPayloads: unknown[] = [];
    let pendingContent: unknown = null;
    const localId = 'daemon-initial-prompt:s1';

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          committedPayloads.push(payload);
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    enqueuePendingQueueV2MessageViaHttpMock.mockImplementationOnce(async (params: any) => {
      const body = params?.body;
      pendingContent = typeof body?.ciphertext === 'string'
        ? { t: 'encrypted', c: body.ciphertext }
        : body?.content ?? null;
    });
    materializeNextPendingQueueV2MessageMock.mockImplementationOnce(async () => ({
      didMaterialize: true,
      localId,
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: 'm-row-first-l1',
        seq: 1,
        localId,
        messageRole: 'user',
        content: pendingContent,
        createdAt: 1_000,
        updatedAt: 1_000,
        deliveryState: { mode: 'provider', unresolved: true },
      },
    }));

    const client = new ApiSessionClient('tok', createMockSession({
      id: 's1',
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }) as any);
    await enableProviderAcceptanceMode(client);

    const received: any[] = [];
    const receivedInfos: any[] = [];
    client.onUserMessage((msg, info) => {
      received.push(msg);
      receivedInfos.push(info);
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'hello from row-first provider delivery',
      localId,
      meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      deliveryStateOptIn: true,
    }));
    expect(received).toHaveLength(1);
    expect(received[0]?.localId).toBe(localId);
    expect(received[0]?.content?.text).toBe('hello from row-first provider delivery');
    expect(receivedInfos[0]).toEqual({ seq: null, providerAcceptancePending: true });
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);
    expect(committedPayloads).toHaveLength(0);
  });

  it('persists a deferred delivered watermark when provider acceptance resolves a prior echo seq by localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await enableProviderAcceptanceMode(client);

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(client.getMetadataSnapshot()?.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['l1'] })).toBe(false);

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['l1'] });

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(true);
  });

  it('persists a deferred delivered watermark when a committed echo arrives after provider acceptance by localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await enableProviderAcceptanceMode(client);

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['l1'] });

    expect((client as any).highestDeliveredUserMessageSeq).toBeNull();

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect((client as any).highestDeliveredUserMessageSeq).toBe(1);
  });

  it('persists a deferred delivered watermark when a commit ack arrives after provider acceptance by localId', async () => {
    const commitAck = { resolve: null as ((value: unknown) => void) | null };
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'update-metadata') {
          return { result: 'success', version: 1, metadata: (payload as { metadata?: unknown })?.metadata };
        }
        if (event !== 'message') {
          return { ok: true };
        }
        return new Promise((resolve) => {
          commitAck.resolve = resolve;
        }).then(() => ({
          ok: true,
          id: 'm1',
          seq: 1,
          localId: (payload as { localId?: string } | null)?.localId ?? 'l1',
        }));
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await enableProviderAcceptanceMode(client);
    await waitForCondition(
      () => client.getMetadataSnapshot()?.userMessageDeliveryWatermarkModeV1 === 'providerAcceptance',
      { timeoutMs: 1_000, intervalMs: 5, label: 'provider acceptance watermark mode persistence' },
    );

    client.sendUserTextMessage('hello', {
      localId: 'l1',
      meta: { source: 'cli', sentFrom: 'cli' },
    });

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['l1'] });
    expect((client as any).highestDeliveredUserMessageSeq).toBeNull();

    await vi.waitFor(() => {
      expect(commitAck.resolve).toBeTypeOf('function');
    });
    const releaseCommitAck = commitAck.resolve;
    if (typeof releaseCommitAck !== 'function') {
      throw new Error('expected message commit to be waiting for ack');
    }
    releaseCommitAck(undefined);
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect((client as any).highestDeliveredUserMessageSeq).toBe(1);
  });

  it('keeps waiting for uncommitted local ids when a mixed provider-accepted batch has a partial seq watermark', async () => {
    const commitAck = { resolve: null as ((value: unknown) => void) | null };
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'message') {
          return { ok: true };
        }
        return new Promise((resolve) => {
          commitAck.resolve = resolve;
        }).then(() => ({
          ok: true,
          id: 'm2',
          seq: 2,
          localId: (payload as { localId?: string } | null)?.localId ?? 'l2',
        }));
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await enableProviderAcceptanceMode(client);

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    client.sendUserTextMessage('second', {
      localId: 'l2',
      meta: { source: 'cli', sentFrom: 'cli' },
    });

    await vi.waitFor(() => {
      expect(commitAck.resolve).toBeTypeOf('function');
    });

    client.confirmUserMessageDeliveredToProvider(1, { localIds: ['l1', 'l2'] });
    expect((client as any).highestDeliveredUserMessageSeq).toBe(1);

    const releaseCommitAck = commitAck.resolve;
    if (typeof releaseCommitAck !== 'function') {
      throw new Error('expected message commit to be waiting for ack');
    }
    releaseCommitAck(undefined);
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect((client as any).highestDeliveredUserMessageSeq).toBe(2);
  });

  it('does not advance the delivered watermark from a self echo while provider acceptance owns delivery proof', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'cli-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await enableProviderAcceptanceMode(client);
    (client as any).markCommittedLocalIdAwaitingEcho('cli-1');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'typed from cli' },
              localId: 'cli-1',
              meta: { source: 'cli', sentFrom: 'cli' },
            },
          },
          localId: 'cli-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(client.getMetadataSnapshot()?.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);

    client.confirmUserMessageDeliveredToProvider(1);

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(true);
  });

  it('does not wait for daemon lifecycle notification before delivering the prompt', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const received: any[] = [];
    const slowLifecycleNotify = vi.fn(() => new Promise<void>(() => {}));

    (client as any).notifyDaemonConnectedServiceTurnLifecycle = slowLifecycleNotify;
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(slowLifecycleNotify).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });

  it('waits for daemon lifecycle notification before delivering the prompt when the session was started by the daemon', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      const received: any[] = [];
      let releaseLifecycleNotify: (() => void) | null = null;
      const slowLifecycleNotify = vi.fn(() => new Promise<void>((resolve) => {
        releaseLifecycleNotify = resolve;
      }));

      (client as any).notifyDaemonConnectedServiceTurnLifecycle = slowLifecycleNotify;
      client.onUserMessage((msg) => received.push(msg));

      const enqueuePromise = (client as any).enqueueSessionUserMessage({
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'ios' },
      });

      expect(slowLifecycleNotify).toHaveBeenCalledWith('prompt_or_steer');
      expect(received).toHaveLength(0);

      const release = ((value: (() => void) | null): (() => void) => {
        if (typeof value !== 'function') {
          throw new Error('expected daemon lifecycle notify to block prompt delivery');
        }
        return value;
      })(releaseLifecycleNotify);
      release();
      await enqueuePromise;

      expect(received).toHaveLength(1);
      expect(received[0]?.content?.text).toBe('hello');
    } finally {
      process.argv = originalArgv;
    }
  });

  it('does not deliver a retried same-localId prompt to the agent queue twice', async () => {
    const committedPayloads: any[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          committedPayloads.push(payload);
        }
        return { ok: true, id: 'm1', seq: committedPayloads.length, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(committedPayloads).toHaveLength(2);
    expect(committedPayloads.map((payload) => payload?.localId)).toEqual(['l1', 'l1']);
  });

  it('does not deliver a buffered transcript echo and buffered RPC prompt with the same body localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1 },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('does not deliver a buffered RPC prompt and buffered transcript echo with the same body localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1 },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('continues delivering prompts without localId or with distinct localIds', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'first',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'second',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'third',
      localId: 'l3',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'fourth',
      localId: 'l4',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received.map((message) => message?.content?.text)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    expect(new Set(received.map((message) => message?.localId)).size).toBe(4);
  });

  it('defaults session.userMessage.send meta source/sentFrom to ui when missing', async () => {
    let lastMessagePayload: any = null;

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          lastMessagePayload = payload;
        }
        return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { permissionMode: 'yolo' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(lastMessagePayload?.sid).toBe('s1');
    expect(lastMessagePayload?.localId).toBe('l1');
    expect(lastMessagePayload?.message?.t).toBe('plain');
    expect(lastMessagePayload?.message?.v?.meta?.source).toBe('ui');
    expect(lastMessagePayload?.message?.v?.meta?.sentFrom).toBe('ui');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: lastMessagePayload.message,
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });
});
