import { describe, expect, it, vi } from 'vitest';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createDeferred } from '@/testkit/async/deferred';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient, createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import type { NormalizedAcpPlanSnapshot } from '@/agent/acp/plans';

describe('createAcpRuntime (ensureBackend)', () => {
  it('creates the backend at most once under concurrent calls', async () => {
    const backendReady = createDeferred<void>();
    const backend = createFakeAcpRuntimeBackend();
    const ensureBackend = vi.fn(async () => {
      await backendReady.promise;
      return backend;
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend,
    });

    const first = runtime.startOrLoad({ resumeId: null });
    const second = runtime.startOrLoad({ resumeId: null });
    await Promise.resolve();
    expect(ensureBackend).toHaveBeenCalledTimes(1);
    backendReady.resolve(undefined);
    await Promise.all([first, second]);

    expect(ensureBackend).toHaveBeenCalledTimes(1);
  });

  it('stops the attached tool revision publisher when the runtime resets', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sendAgentMessage = vi.fn();
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides({ sendAgentMessage }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    backend.emit({ type: 'tool-call', toolName: 'read', callId: 'before-reset', args: {} });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);

    await runtime.reset();
    backend.emit({ type: 'tool-call', toolName: 'read', callId: 'after-reset', args: {} });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
  });

  it('awaits canonical plan-state persistence and propagates publication failures', async () => {
    let publishPlanState: ((snapshot: NormalizedAcpPlanSnapshot) => Promise<void>) | null = null;
    const backend = {
      ...createFakeAcpRuntimeBackend(),
      setPlanStatePublisher(publisher: (snapshot: NormalizedAcpPlanSnapshot) => Promise<void>) {
        publishPlanState = publisher;
      },
    };
    type MetadataWithWorkState = Metadata & { sessionWorkStateV1?: unknown };
    let metadata: MetadataWithWorkState = {
      ...createTestMetadata(),
      sessionWorkStateV1: {
        v: 1,
        backendId: 'other',
        updatedAt: 1,
        primaryItemId: 'goal:other',
        items: [{
          id: 'goal:other', kind: 'goal', origin: 'happier', status: 'active', title: 'Keep', updatedAt: 1,
        }],
      },
    };
    let shouldFail = true;
    const updateMetadata = vi.fn(async (updater: (current: Metadata) => Metadata) => {
      if (shouldFail) throw new Error('metadata persistence failed');
      metadata = updater(metadata) as MetadataWithWorkState;
    });
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides({ updateMetadata }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    expect(publishPlanState).not.toBeNull();
    const snapshot: NormalizedAcpPlanSnapshot = {
      providerId: 'cursor',
      turnId: 'turn-1',
      source: 'proprietary',
      merge: false,
      items: [{ vendorRef: 'todo-1', title: 'Implement', status: 'active', order: 0 }],
    };
    await expect(publishPlanState!(snapshot)).rejects.toThrow('metadata persistence failed');
    shouldFail = false;
    await expect(publishPlanState!(snapshot)).resolves.toBeUndefined();

    expect((metadata.sessionWorkStateV1 as { items: Array<{ id: string; title: string }> }).items).toEqual([
      expect.objectContaining({ id: 'goal:other', title: 'Keep' }),
      expect.objectContaining({
        id: expect.stringMatching(/^todo:derived:acp\.plan\.cursor:/),
        vendorRef: 'todo-1',
        title: 'Implement',
      }),
    ]);
  });
});
