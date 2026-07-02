/**
 * X8 — Stale-but-usable quota
 *
 * When a quota refresh fails (network error, provider_backoff, etc.) and a previous
 * stale snapshot exists in the runtime store, that snapshot must be kept with an
 * explicit stale_quota annotation (details.code = 'stale_quota') so the UI can
 * surface "stale data" instead of silently discarding it.
 *
 * This is enforced in the ConnectedServiceQuotasCoordinator tick path.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { buildConnectedServiceCredentialRecord, type ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher } from './types';
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW_MS = 2_000_000;

function buildRecord(now: number) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 60_000,
    oauth: {
      accessToken: 'tok',
      refreshToken: 'rt',
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

function buildStaleSnapshot(overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    profileId: 'work',
    fetchedAt: NOW_MS - 600_000, // 10 minutes old
    staleAfterMs: 300_000,       // stale after 5 minutes
    planLabel: 'pro',
    accountLabel: 'user@example.com',
    meters: [
      {
        meterId: 'session',
        label: 'Session',
        used: null,
        limit: null,
        unit: 'unknown',
        utilizationPct: 42,
        resetsAt: null,
        status: 'ok',
        details: {},
      },
    ],
    ...overrides,
  };
}

function buildMockRuntimeStore(): ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore & { recorded: Array<unknown> } {
  const recorded: Array<unknown> = [];
  const store: Record<string, unknown> & { recorded: Array<unknown> } = {
    recorded,
    recordProfileSnapshot(input: unknown) {
      recorded.push({ type: 'profile', ...(input as Record<string, unknown>) });
    },
    recordSnapshot(input: unknown) {
      recorded.push({ type: 'group', ...(input as Record<string, unknown>) });
    },
    buildMemberStates() { return new Map(); },
    getSnapshot() { return null; },
  };
  return store as unknown as ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore & { recorded: Array<unknown> };
}

function buildFailingFetcher(code: ConnectedServiceQuotaFetchError['quotaFetchErrorCode'] = 'provider_backoff'): ConnectedServiceQuotaFetcher {
  return {
    serviceId: 'openai-codex',
    fetch: async () => {
      throw new ConnectedServiceQuotaFetchError('test failure', {
        status: 503,
        quotaFetchErrorCode: code,
      });
    },
  };
}

describe('ConnectedServiceQuotasCoordinator — X8: stale-but-usable quota on fetch failure', () => {
  it('keeps last-known snapshot in runtime store with stale_quota annotation when refresh fails', async () => {
    const staleSnapshot = buildStaleSnapshot();
    const runtimeStore = buildMockRuntimeStore();

    // Simulate: there is a stale snapshot on the server (fetchedAt in the past, past staleAfterMs)
    const mockApi = {
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: staleSnapshot },
        metadata: {
          fetchedAt: staleSnapshot.fetchedAt,
          staleAfterMs: staleSnapshot.staleAfterMs,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: buildRecord(NOW_MS) },
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    };

    const mockCredentials = {
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: mockApi,
      credentials: mockCredentials as never,
      quotaFetchers: [buildFailingFetcher('network')],
      now: () => NOW_MS,
      randomBytes: (n) => new Uint8Array(n),
      runtimeQuotaSnapshots: runtimeStore,
      // Disable discovery so the coordinator only processes registered bindings
      discoveryEnabled: false,
    });

    coordinator.registerSpawnTarget({
      pid: 1234,
      sessionId: 'sess-abc',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    });

    await coordinator.tickOnce();

    // The runtime store must have received a snapshot — the stale one with a stale_quota code
    expect(runtimeStore.recorded.length).toBeGreaterThan(0);

    const profileRecords = runtimeStore.recorded.filter((r) => (r as { type: string }).type === 'profile');
    expect(profileRecords.length).toBeGreaterThan(0);

    const recordedSnapshot = (profileRecords[0] as { snapshot: ConnectedServiceQuotaSnapshotV1 }).snapshot;
    expect(recordedSnapshot.serviceId).toBe('openai-codex');

    // All meters must carry the stale_quota annotation
    expect(recordedSnapshot.meters.every((m) => m.details?.code === 'stale_quota')).toBe(true);
  });

  it('does NOT mark snapshot as stale_quota when the refresh succeeds and snapshot is fresh', async () => {
    const freshSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: NOW_MS - 10_000, // 10 seconds old — fresh
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: 'user@example.com',
      meters: [
        {
          meterId: 'session',
          label: 'Session',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 20,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
      ],
    };

    const runtimeStore = buildMockRuntimeStore();

    const mockApi = {
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: freshSnapshot },
        metadata: {
          fetchedAt: freshSnapshot.fetchedAt,
          staleAfterMs: freshSnapshot.staleAfterMs,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    };

    const mockCredentials = {
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: mockApi,
      credentials: mockCredentials as never,
      quotaFetchers: [buildFailingFetcher()],
      now: () => NOW_MS,
      randomBytes: (n) => new Uint8Array(n),
      runtimeQuotaSnapshots: runtimeStore,
      discoveryEnabled: false,
    });

    coordinator.registerSpawnTarget({
      pid: 5678,
      sessionId: 'sess-xyz',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    });

    await coordinator.tickOnce();

    // Fresh snapshot is returned from the cache path — should NOT have stale_quota tag
    const profileRecords = runtimeStore.recorded.filter((r) => (r as { type: string }).type === 'profile');
    if (profileRecords.length > 0) {
      const snap = (profileRecords[0] as { snapshot: ConnectedServiceQuotaSnapshotV1 }).snapshot;
      // No meter should have stale_quota in the fresh case
      expect(snap.meters.every((m) => m.details?.code !== 'stale_quota')).toBe(true);
    }
  });
});
