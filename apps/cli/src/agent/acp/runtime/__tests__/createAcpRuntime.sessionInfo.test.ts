import { describe, expect, it } from 'vitest';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import {
  createBasicSessionClientWithOverrides,
  createSessionClientWithMetadata,
} from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';

describe('createAcpRuntime provider session info', () => {
  it('does not lose session info emitted before session/new resolves', async () => {
    let backend!: ReturnType<typeof createFakeAcpRuntimeBackend>;
    backend = createFakeAcpRuntimeBackend({
      sessionId: 'provider-session-early',
      async startSession() {
        backend.emit({
          type: 'event',
          name: 'session_info_update',
          payload: { title: 'Early provider title' },
        });
        backend.emit({
          type: 'event',
          name: 'session_info_update',
          payload: { updatedAt: '2026-07-11T10:00:00.000Z' },
        });
        return { sessionId: 'provider-session-early' };
      },
    });
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    expect(getMetadata().summary?.text).toBe('Early provider title');
    expect(getMetadata().providerSessionInfoV1?.sessionId).toBe('provider-session-early');
    expect(getMetadata().providerSessionInfoV1?.updatedAt).toBe('2026-07-11T10:00:00.000Z');
  });

  it('retains provider metadata while applying title initialization precedence', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'provider-session-1' });
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    backend.emit({
      type: 'event',
      name: 'session_info_update',
      payload: { title: 'Provider title', updatedAt: '2026-07-11T10:00:00.000Z' },
    });

    expect(getMetadata().summary?.text).toBe('Provider title');
    expect(getMetadata().providerSessionInfoV1).toMatchObject({
      provider: 'cursor',
      sessionId: 'provider-session-1',
      title: 'Provider title',
      updatedAt: '2026-07-11T10:00:00.000Z',
    });

    await Promise.resolve(session.updateMetadata((metadata) => ({
      ...metadata,
      summary: { text: 'Explicit Happier title', updatedAt: 200 },
    })));
    backend.emit({
      type: 'event',
      name: 'session_info_update',
      payload: { title: 'Changed provider title' },
    });

    expect(getMetadata().summary).toEqual({ text: 'Explicit Happier title', updatedAt: 200 });
    expect(getMetadata().providerSessionInfoV1?.title).toBe('Changed provider title');
  });

  it('does not let a deferred prior-lifecycle session-info write mutate metadata after reset', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'provider-session-old' });
    let metadata = createTestMetadata();
    let deferredUpdater: ((current: Metadata) => Metadata) | null = null;
    const session = createBasicSessionClientWithOverrides({
      updateMetadata: (updater) => {
        deferredUpdater = updater;
      },
    });
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    backend.emit({
      type: 'event',
      name: 'session_info_update',
      payload: { title: 'Stale provider title' },
    });
    expect(deferredUpdater).not.toBeNull();

    await runtime.reset();
    metadata = deferredUpdater!(metadata);

    expect(metadata.providerSessionInfoV1).toBeUndefined();
    expect(metadata.summary).toBeUndefined();
  });

  it('does not carry a late disposed-backend session-info event into the next session', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'provider-session' });
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.reset();
    backend.emit({
      type: 'event',
      name: 'session_info_update',
      payload: { title: 'Late title from disposed backend' },
    });
    await runtime.startOrLoad({ resumeId: null });

    expect(getMetadata().providerSessionInfoV1).toBeUndefined();
    expect(getMetadata().summary).toBeUndefined();
  });

});
