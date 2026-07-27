import { afterEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from './recordConnectedServiceRuntimeQuotaSnapshotForSession';
import {
  createConnectedServiceQuotaSnapshotDeliveryOutbox,
  type ConnectedServiceQuotaSnapshotDeliveryInput,
} from './connectedServiceQuotaSnapshotDeliveryOutbox';

function quotaSnapshot(overrides: Partial<{
  serviceId: 'openai-codex' | 'claude-subscription';
  profileId: string;
  activeAccountId: string | null;
  accountLabel: string | null;
  fetchedAt: number;
  remainingPct: number;
  resetAtMs: number | null;
}> = {}) {
  const serviceId = overrides.serviceId ?? 'openai-codex';
  const profileId = overrides.profileId ?? 'primary';
  const remainingPct = overrides.remainingPct ?? 0;
  return {
    v: 1 as const,
    serviceId,
    profileId,
    fetchedAt: overrides.fetchedAt ?? 1_000,
    staleAfterMs: 300_000,
    providerId: serviceId === 'openai-codex' ? 'codex' : 'claude',
    ...(overrides.activeAccountId ? { activeAccountId: overrides.activeAccountId } : {}),
    accountLabel: overrides.accountLabel ?? null,
    planLabel: null,
    meters: [
      {
        meterId: 'main',
        label: 'Main',
        used: null,
        limit: null,
        unit: 'unknown' as const,
        utilizationPct: 100 - remainingPct,
        remainingPct,
        resetsAt: overrides.resetAtMs ?? null,
        resetAtMs: overrides.resetAtMs ?? null,
        status: 'ok' as const,
        limitCategory: 'usage_limit' as const,
        details: {},
      },
    ],
  };
}

describe('createConnectedServiceQuotaSnapshotDeliveryOutbox', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes the latest coalesced snapshot after transient local-control failures', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ error: 'daemon still offline' })
      .mockResolvedValueOnce({ ok: true });
    const diagnostics: unknown[] = [];
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

	    await outbox.enqueueAndFlush({
	      sessionId: 'sess_1',
	      serviceId: 'openai-codex',
	      groupId: 'main',
	      groupGeneration: 2,
	      snapshot: quotaSnapshot({ activeAccountId: 'acct_latest', fetchedAt: 1_000 }),
	    });
	    outbox.enqueue({
	      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_latest', fetchedAt: 2_000 }),
    });

    await outbox.flushPending({ reason: 'periodic_retry' });
    await outbox.flushPending({ reason: 'daemon_reconnect' });

	    expect(deliver).toHaveBeenCalledTimes(3);
	    expect(deliver.mock.calls.map((call) => call[0].snapshot.activeAccountId)).toEqual([
	      'acct_latest',
	      'acct_latest',
	      'acct_latest',
	    ]);
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: {
        profileId: 'primary',
        activeAccountId: 'acct_latest',
      },
    });
    expect(outbox.pendingCount()).toBe(0);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'quota_snapshot_delivery_retrying',
        sessionId: 'sess_1',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeAccountId: 'acct_latest',
        attemptCount: 1,
        reason: 'daemon_quota_snapshot_delivery_failed',
      }),
    ]));
  });

  it('coalesces repeated snapshots for one exact session/service/group/account/generation identity to the latest payload', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ ok: true });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_1', fetchedAt: 1_000 }),
    });
    outbox.enqueue({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_1', fetchedAt: 2_000 }),
    });
    outbox.enqueue({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_1', fetchedAt: 3_000 }),
    });

    expect(outbox.pendingCount()).toBe(1);
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({
      groupGeneration: 1,
      snapshot: {
        activeAccountId: 'acct_1',
        fetchedAt: 3_000,
      },
    });
    expect(outbox.pendingCount()).toBe(0);
  });

  it('retains distinct pending snapshots for different account or generation authority dimensions', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_old', fetchedAt: 1_000 }),
    });
	    outbox.enqueue({
	      sessionId: 'sess_1',
	      serviceId: 'openai-codex',
	      groupId: 'main',
	      groupGeneration: 2,
	      snapshot: quotaSnapshot({ activeAccountId: 'acct_new', fetchedAt: 2_000 }),
	    });
    outbox.enqueue({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_newer', fetchedAt: 3_000 }),
    });

    expect(outbox.pendingCount()).toBe(3);
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(4);
    expect(deliver.mock.calls.map((call) => ({
      activeAccountId: call[0].snapshot.activeAccountId,
      groupGeneration: call[0].groupGeneration,
    }))).toEqual([
      { activeAccountId: 'acct_old', groupGeneration: 1 },
      { activeAccountId: 'acct_old', groupGeneration: 1 },
      { activeAccountId: 'acct_new', groupGeneration: 2 },
      { activeAccountId: 'acct_newer', groupGeneration: 2 },
    ]);
    expect(outbox.pendingCount()).toBe(0);
  });

  it('keeps pending snapshots for different quota profiles separate', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({
        profileId: 'exhausted-profile',
        activeAccountId: 'acct_exhausted',
        fetchedAt: 1_000,
        remainingPct: 0,
      }),
    });
    outbox.enqueue({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({
        profileId: 'healthy-profile',
        activeAccountId: 'acct_healthy',
        fetchedAt: 2_000,
        remainingPct: 80,
      }),
    });

    expect(outbox.pendingCount()).toBe(2);
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls.map((call) => call[0].snapshot.profileId)).toEqual([
      'exhausted-profile',
      'exhausted-profile',
      'healthy-profile',
    ]);
    expect(outbox.pendingCount()).toBe(0);
  });

  it('preserves a newer coalesced snapshot when a stale in-flight delivery succeeds', async () => {
    let resolveFirstDelivery: (value: unknown) => void = () => {};
    const firstDelivery = new Promise<unknown>((resolve) => {
      resolveFirstDelivery = resolve;
    });
    const deliver = vi.fn()
      .mockReturnValueOnce(firstDelivery)
      .mockResolvedValueOnce({ ok: true });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    const firstFlush = outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_old', fetchedAt: 1_000 }),
    });
    expect(deliver).toHaveBeenCalledTimes(1);

	    outbox.enqueue({
	      sessionId: 'sess_1',
	      serviceId: 'openai-codex',
	      groupId: 'main',
	      groupGeneration: 1,
	      snapshot: quotaSnapshot({ activeAccountId: 'acct_old', fetchedAt: 2_000 }),
	    });
    resolveFirstDelivery({ ok: true });
    await firstFlush;

    expect(outbox.pendingCount()).toBe(1);
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({
      groupGeneration: 1,
      snapshot: {
        activeAccountId: 'acct_old',
        fetchedAt: 2_000,
      },
    });
    expect(outbox.pendingCount()).toBe(0);
  });

  it('preserves a newer coalesced snapshot when a stale in-flight delivery fails', async () => {
    let resolveFirstDelivery: (value: unknown) => void = () => {};
    const firstDelivery = new Promise<unknown>((resolve) => {
      resolveFirstDelivery = resolve;
    });
    const deliver = vi.fn()
      .mockReturnValueOnce(firstDelivery)
      .mockResolvedValueOnce({ ok: true });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    const firstFlush = outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_old', fetchedAt: 1_000 }),
    });
    expect(deliver).toHaveBeenCalledTimes(1);

    outbox.enqueue({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_old', fetchedAt: 2_000 }),
    });
    resolveFirstDelivery({ error: 'daemon offline' });
    await firstFlush;

    expect(outbox.pendingCount()).toBe(1);
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({
      groupGeneration: 1,
      snapshot: {
        activeAccountId: 'acct_old',
        fetchedAt: 2_000,
      },
    });
    expect(outbox.pendingCount()).toBe(0);
  });

  it('flushes retained pending payloads after a long offline interval', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ ok: true });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_old', fetchedAt: 1_000 }),
    });

    outbox.enqueue({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_new', fetchedAt: 2_000 }),
    });
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[1]?.[0]).toMatchObject({
      groupGeneration: 1,
      snapshot: {
        activeAccountId: 'acct_old',
        fetchedAt: 1_000,
      },
    });
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({
      groupGeneration: 2,
      snapshot: {
        activeAccountId: 'acct_new',
        fetchedAt: 2_000,
      },
    });
    expect(outbox.pendingCount()).toBe(0);
  });

  it('automatically retries pending snapshots until delivery succeeds', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ error: 'daemon still offline' })
      .mockResolvedValueOnce({ ok: true });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
      retryDelayMs: 10,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot: quotaSnapshot({ activeAccountId: 'acct_live' }),
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(outbox.pendingCount()).toBe(0);
  });

  it('stops automatic retry at the bound while retaining the latest snapshot for a reconnect flush', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn(async (): Promise<unknown> => ({ error: 'daemon offline' }));
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 2,
      retryDelayMs: 10,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_live', fetchedAt: 1_000 }),
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(outbox.pendingCount()).toBe(1);

    deliver.mockResolvedValueOnce({ ok: true });
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(outbox.pendingCount()).toBe(0);
  });

  it('does not spend an exhausted slot again when a different new snapshot flushes initially', async () => {
    const deliver = vi.fn(async (_input: ConnectedServiceQuotaSnapshotDeliveryInput) => ({
      error: 'daemon offline',
    }));
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 1,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_exhausted' }),
    });
    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 2,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_new' }),
    });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map((call) => call[0].snapshot.activeAccountId)).toEqual([
      'acct_exhausted',
      'acct_new',
    ]);
  });

  it('reports overflow drops in the next flush result', async () => {
    const diagnostics: unknown[] = [];
    const deliver = vi.fn(async () => ({ ok: true }));
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxPendingEntries: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    outbox.enqueue({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_evicted' }),
    });

    const result = await outbox.enqueueAndFlush({
      sessionId: 'sess_2',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 1,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_kept' }),
    });

    expect(result).toEqual({
      attempted: 1,
      delivered: 1,
      pending: 0,
      dropped: 1,
    });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'quota_snapshot_delivery_dropped',
        reason: 'quota_snapshot_outbox_overflow',
        sessionId: 'sess_1',
      }),
    ]));
  });


  it('keeps the latest pending snapshot after bounded daemon delivery failures so reconnect can flush it', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ error: 'daemon still offline' })
      .mockResolvedValueOnce({ ok: true });
    const diagnostics: unknown[] = [];
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 2,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      snapshot: quotaSnapshot({ activeAccountId: 'acct_live' }),
    });
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(outbox.pendingCount()).toBe(1);
    expect(diagnostics.at(-1)).toEqual(expect.objectContaining({
      event: 'quota_snapshot_delivery_retrying',
      phase: 'quota_snapshot_delivery',
      reason: 'daemon_quota_snapshot_delivery_failed',
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeAccountId: 'acct_live',
      attemptCount: 2,
      maxAttempts: 2,
      lastError: 'daemon still offline',
    }));

    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(outbox.pendingCount()).toBe(0);
  });

  it('keeps the latest pending snapshot across a long offline interval so reconnect can flush stale display evidence', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ ok: true });
    const diagnostics: unknown[] = [];
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      snapshot: quotaSnapshot({
        activeAccountId: 'acct_stale_but_latest',
        fetchedAt: 1_000,
        remainingPct: 0,
      }),
    });

    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      snapshot: {
        activeAccountId: 'acct_stale_but_latest',
        fetchedAt: 1_000,
      },
    });
    expect(outbox.pendingCount()).toBe(0);
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'quota_snapshot_delivery_dropped',
      }),
    ]));
  });

  it('clears pending snapshots when a session exits', async () => {
    const deliver = vi.fn(async () => ({ error: 'daemon offline' }));
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot: quotaSnapshot({ activeAccountId: 'acct_live' }),
    });

    expect(outbox.clearSession('sess_1')).toBe(1);
    expect(outbox.pendingCount()).toBe(0);

    await outbox.flushPending({ reason: 'periodic_retry' });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('flushes a cold-reconnect runtime quota snapshot without driving daemon fanout state', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    let daemonOnline = false;
    const deliver = vi.fn(async (body) => {
      if (!daemonOnline) return { error: 'daemon offline' };
      return await recordConnectedServiceRuntimeQuotaSnapshotForSession({
        getChildren: () => [{
          startedBy: 'daemon',
          happySessionId: 'sess_1',
          pid: 123,
          spawnOptions: {
            directory: '/tmp/project',
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'group',
                  profileId: 'primary',
                  groupId: 'main',
                },
              },
            },
            environmentVariables: {
              [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'main',
                activeProfileId: 'primary',
                fallbackProfileId: 'backup',
                generation: 42,
              }]),
            },
          },
        }],
        runtimeQuotaSnapshots,
        sessionId: body.sessionId,
        serviceId: body.serviceId,
        snapshot: body.snapshot,
      });
    });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 42,
      snapshot: quotaSnapshot({
        activeAccountId: 'acct_live_codex',
        remainingPct: 0,
        resetAtMs: 10_000,
      }),
    });

    daemonOnline = true;
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(outbox.pendingCount()).toBe(0);
  });

  it('delivers non-Codex quota snapshots without assuming provider account payload shape', async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ error: 'daemon offline' })
      .mockResolvedValueOnce({ ok: true });
    const outbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
      deliver,
      maxAttempts: 5,
    });

    await outbox.enqueueAndFlush({
      sessionId: 'sess_claude',
      serviceId: 'claude-subscription',
      groupId: 'team',
      groupGeneration: 4,
      snapshot: quotaSnapshot({
        serviceId: 'claude-subscription',
        profileId: 'claude-main',
        accountLabel: null,
        remainingPct: 0,
      }),
    });
    await outbox.flushPending({ reason: 'daemon_reconnect' });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 'sess_claude',
      serviceId: 'claude-subscription',
      groupId: 'team',
      groupGeneration: 4,
      snapshot: {
        serviceId: 'claude-subscription',
        profileId: 'claude-main',
      },
    });
    expect(outbox.pendingCount()).toBe(0);
  });
});
