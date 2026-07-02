import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  createCodexQuotaSnapshotDeliveryOutboxForNotify,
  flushPendingCodexQuotaSnapshotsToDaemon,
  reportCodexRateLimitSnapshotToDaemon,
} from './reportCodexRateLimitSnapshotToDaemon';

type NotifyQuotaSnapshotInput = Readonly<{
  sessionId: string;
  serviceId: 'openai-codex';
  groupId?: string | null;
  groupGeneration?: number | null;
  snapshot: unknown;
}>;

function createNotifyQuotaSnapshotMock() {
  return vi.fn(async (_body: NotifyQuotaSnapshotInput) => ({ ok: true }));
}

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.');
}

describe('reportCodexRateLimitSnapshotToDaemon', () => {
  it('reports app-server rate-limit snapshots for the active connected-service group member', async () => {
    const notify = createNotifyQuotaSnapshotMock();

    await reportCodexRateLimitSnapshotToDaemon({
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'primary',
          generation: 2,
        }]),
      },
      sessionId: 'sess_1',
      rawSnapshot: {
        plan_type: 'pro',
        primary: { used_percent: 88, resets_at: '2026-05-17T12:00:00.000Z' },
      },
      nowMs: 1_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: 1_000,
        planLabel: 'pro',
      }),
    });
  });

  it('routes connected-service group snapshots through the shared delivery outbox with runtime identity context', async () => {
    const notify = createNotifyQuotaSnapshotMock();
    const deliveryOutbox = {
      enqueue: vi.fn(),
      enqueueAndFlush: vi.fn(async () => ({
        attempted: 1,
        delivered: 1,
        pending: 0,
        dropped: 0,
      })),
      flushPending: vi.fn(),
      clearSession: vi.fn(),
      pendingCount: vi.fn(),
    };

    await reportCodexRateLimitSnapshotToDaemon({
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'primary',
          generation: 9,
        }]),
      },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 100 } },
      activeAccountId: 'acct_live',
      nowMs: 1_000,
      notify,
      deliveryOutbox,
    });

    expect(notify).not.toHaveBeenCalled();
    expect(deliveryOutbox.enqueueAndFlush).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 9,
      snapshot: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'backup',
        activeAccountId: 'acct_live',
      }),
    });
  });

  it('attributes post-hot-apply snapshots to the current session metadata member, not the stale child env selection', async () => {
    const notify = createNotifyQuotaSnapshotMock();

    await reportCodexRateLimitSnapshotToDaemon({
      env: {
        // The child env keeps naming the PRE-switch member after a hot-apply
        // group switch; it must not own snapshot attribution.
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'exhausted-member',
          fallbackProfileId: 'fresh-member',
          generation: 2,
        }]),
      },
      session: {
        getMetadataSnapshot: () => ({
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                groupId: 'main',
                profileId: 'fresh-member',
              },
            },
          },
        }),
      },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 5 } },
      nowMs: 1_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'fresh-member',
      }),
    }));
  });

  it('falls back to the child env selection when session metadata has no usable connected binding', async () => {
    const notify = createNotifyQuotaSnapshotMock();

    await reportCodexRateLimitSnapshotToDaemon({
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'primary',
          generation: 2,
        }]),
      },
      session: {
        getMetadataSnapshot: () => ({ connectedServices: null }),
      },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 88 } },
      nowMs: 1_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: expect.objectContaining({ profileId: 'backup' }),
    }));
  });

  it('does not report selected auth-store account id as live activeAccountId for connected-service snapshots', async () => {
    const root = join(tmpdir(), `happier-codex-connected-quota-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: {
        id_token: {
          chatgpt_account_id: 'acct_selected_not_proven_live',
        },
      },
    }));
    const notify = vi.fn(async (_body: NotifyQuotaSnapshotInput) => ({ ok: true }));

    await reportCodexRateLimitSnapshotToDaemon({
      env: {
        CODEX_HOME: codexHome,
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'primary',
          generation: 2,
        }]),
      },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 88 } },
      nowMs: 1_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: expect.not.objectContaining({
        activeAccountId: 'acct_selected_not_proven_live',
      }),
    }));
    const firstCall = notify.mock.calls[0]?.[0];
    expect(firstCall?.snapshot).not.toHaveProperty('activeAccountId');
  });

  it('reports connected-service activeAccountId only when the app-server snapshot carries live account proof', async () => {
    const root = join(tmpdir(), `happier-codex-connected-live-quota-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: {
        id_token: {
          chatgpt_account_id: 'acct_selected_not_live',
        },
      },
    }));
    const notify = createNotifyQuotaSnapshotMock();

    await reportCodexRateLimitSnapshotToDaemon({
      env: {
        CODEX_HOME: codexHome,
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'primary',
          generation: 2,
        }]),
      },
      sessionId: 'sess_1',
      rawSnapshot: {
        account: {
          id: 'acct_live_codex',
          email: 'live@example.test',
        },
        primary: { used_percent: 88 },
      },
      nowMs: 1_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: expect.objectContaining({
        profileId: 'backup',
        activeAccountId: 'acct_live_codex',
        accountLabel: 'live@example.test',
      }),
    }));
  });

  it('reports connected-service activeAccountId when the runtime supplies live account/read proof', async () => {
    const notify = createNotifyQuotaSnapshotMock();

    await reportCodexRateLimitSnapshotToDaemon({
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'primary',
          generation: 2,
        }]),
      },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 100 } },
      activeAccountId: 'acct_live_from_account_read',
      accountLabel: 'live-account@example.test',
      nowMs: 1_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: expect.objectContaining({
        profileId: 'backup',
        activeAccountId: 'acct_live_from_account_read',
        accountLabel: 'live-account@example.test',
      }),
    }));
  });

  it('normalizes merged sparse app-server snapshots without erasing identity or reset windows', async () => {
    const notify = createNotifyQuotaSnapshotMock();

    await reportCodexRateLimitSnapshotToDaemon({
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'primary',
          generation: 2,
        }]),
      },
      sessionId: 'sess_1',
      rawSnapshot: {
        rateLimits: {
          account: {
            id: 'acct_live_codex',
            email: 'codex-user@example.test',
          },
          primary: {
            usedPercent: 88,
            windowDurationMins: 300,
            resetsAt: 1_779_098_400,
          },
          secondary: {
            usedPercent: 40,
            windowDurationMins: 10080,
            resetsAt: 1_779_698_400,
          },
          planType: 'pro',
        },
      },
      nowMs: 1_000,
      notify,
    });

    const snapshot = notify.mock.calls[0]?.[0]?.snapshot;
    expect(snapshot).toMatchObject({
      serviceId: 'openai-codex',
      profileId: 'backup',
      activeAccountId: 'acct_live_codex',
      accountLabel: 'codex-user@example.test',
      planLabel: 'pro',
      meters: [
        {
          meterId: 'primary',
          utilizationPct: 88,
          resetAtMs: 1_779_098_400_000,
          resetsAt: 1_779_098_400_000,
        },
        {
          meterId: 'secondary',
          utilizationPct: 40,
          resetAtMs: 1_779_698_400_000,
          resetsAt: 1_779_698_400_000,
        },
      ],
    });
  });

  it('leaves failed daemon quota snapshot delivery pending for the shared outbox retry path', async () => {
    const notify = vi.fn().mockResolvedValueOnce({ error: 'timeout' });

    await expect(reportCodexRateLimitSnapshotToDaemon({
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'backup',
        }]),
      },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 100 } },
      activeAccountId: 'acct_live',
      nowMs: 1_000,
      notify,
    })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      pending: 1,
      dropped: 0,
    });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('flushes pending daemon quota snapshots when the provider session is reported again', async () => {
    const notify = vi.fn()
      .mockResolvedValueOnce({ error: 'No daemon running, no state file found' })
      .mockResolvedValueOnce({ ok: true });
    const deliveryOutbox = createCodexQuotaSnapshotDeliveryOutboxForNotify({
      notify,
      retryDelayMs: null,
    });

    await expect(reportCodexRateLimitSnapshotToDaemon({
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'backup',
        }]),
      },
      sessionId: 'sess_provider_reconnect',
      rawSnapshot: { primary: { used_percent: 100 } },
      activeAccountId: 'acct_live',
      nowMs: 1_000,
      deliveryOutbox,
    })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      pending: 1,
      dropped: 0,
    });

    await expect(flushPendingCodexQuotaSnapshotsToDaemon({
      deliveryOutbox,
      sessionId: 'sess_provider_reconnect',
      reason: 'session_report',
    })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      pending: 0,
      dropped: 0,
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does not reject usage-limit recovery when daemon quota snapshot delivery remains pending', async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error('socket timeout'));
    const onDeliveryFailure = vi.fn();

    await expect(reportCodexRateLimitSnapshotToDaemon({
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'backup',
        }]),
      },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 100 } },
      activeAccountId: 'acct_live',
      nowMs: 1_000,
      notify,
      onDeliveryFailure,
    })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      pending: 1,
      dropped: 0,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(onDeliveryFailure).toHaveBeenCalledWith({
      event: 'quota_snapshot_delivery_retrying',
      phase: 'quota_snapshot_delivery',
      reason: 'daemon_quota_snapshot_delivery_failed',
      serviceId: 'openai-codex',
      sessionId: 'sess_1',
      profileId: 'backup',
      groupId: null,
      activeAccountId: 'acct_live',
      groupGeneration: null,
      attemptCount: 1,
      maxAttempts: 5,
      lastError: 'socket timeout',
      flushReason: 'initial',
    });
  });

  it('reports native app-server snapshots with stable Codex account identity when no connected auth is selected', async () => {
    const root = join(tmpdir(), `happier-codex-native-quota-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: {
        id_token: {
          chatgpt_account_id: 'acct_native_codex',
        },
      },
    }));
    const notify = createNotifyQuotaSnapshotMock();

    await reportCodexRateLimitSnapshotToDaemon({
      env: { CODEX_HOME: codexHome },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 88 } },
      nowMs: 1_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: null,
      groupGeneration: null,
      snapshot: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: expect.stringMatching(/^acct:[a-f0-9]{48}$/u),
        activeAccountId: 'acct_native_codex',
        providerId: 'codex',
      }),
    }));
  });

  it('uses the native Codex auth-store email as the quota account label when the rate-limit payload is email-less', async () => {
    const root = join(tmpdir(), `happier-codex-native-quota-email-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: {
        id_token: buildJwt({
          chatgpt_account_id: 'acct_native_codex',
          email: 'codex-user@example.test',
        }),
      },
    }));
    const notify = createNotifyQuotaSnapshotMock();

    await reportCodexRateLimitSnapshotToDaemon({
      env: { CODEX_HOME: codexHome },
      sessionId: 'sess_1',
      rawSnapshot: { primary: { used_percent: 44 } },
      nowMs: 1_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: null,
      groupGeneration: null,
      snapshot: expect.objectContaining({
        activeAccountId: 'acct_native_codex',
        accountLabel: 'codex-user@example.test',
      }),
    }));
  });
});
