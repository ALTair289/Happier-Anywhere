import { afterEach, describe, expect, it, vi } from 'vitest';

const notifyDaemonConnectedServiceQuotaSnapshot = vi.fn(async (_body: unknown) => ({ ok: true }));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceQuotaSnapshot: (body: unknown) =>
    notifyDaemonConnectedServiceQuotaSnapshot(body),
}));

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { deliverConnectedServiceQuotaSnapshotToDaemon } from './deliverConnectedServiceQuotaSnapshotToDaemon';
import { createCodexQuotaSnapshotDeliveryOutboxForNotify } from '@/backends/codex/connectedServices/reportCodexRateLimitSnapshotToDaemon';

const snapshot = { v: 1 } as unknown as ConnectedServiceQuotaSnapshotV1;

afterEach(() => {
  notifyDaemonConnectedServiceQuotaSnapshot.mockClear();
});

describe('deliverConnectedServiceQuotaSnapshotToDaemon', () => {
  it('forwards the full payload including sourceProviderAccountId to the daemon door', async () => {
    await deliverConnectedServiceQuotaSnapshotToDaemon({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 3,
      sourceProviderAccountId: 'acct-provider-123',
      credentialFingerprint: 'sha256:abcdef12',
      snapshot,
    });

    expect(notifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProviderAccountId: 'acct-provider-123',
        credentialFingerprint: 'sha256:abcdef12',
        serviceId: 'openai-codex',
      }),
    );
  });
});

describe('createCodexQuotaSnapshotDeliveryOutboxForNotify (no explicit notify)', () => {
  it('routes runCodex-style delivery through the shared helper and preserves sourceProviderAccountId', async () => {
    // Exactly how runCodex now builds its outbox (onDiagnostic only, no hand-rolled notify).
    const outbox = createCodexQuotaSnapshotDeliveryOutboxForNotify({
      onDiagnostic: () => {},
    });

    await outbox.enqueueAndFlush({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 3,
      sourceProviderAccountId: 'acct-provider-123',
      credentialFingerprint: 'sha256:abcdef12',
      snapshot,
    });

    expect(notifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledTimes(1);
    expect(notifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProviderAccountId: 'acct-provider-123',
        credentialFingerprint: 'sha256:abcdef12',
      }),
    );
  });
});
