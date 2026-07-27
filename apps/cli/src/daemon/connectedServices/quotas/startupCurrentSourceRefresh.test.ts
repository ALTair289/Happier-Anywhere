import { randomBytes } from 'node:crypto';

import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceQuotaSnapshotV1,
  type ConnectedServiceUsageSourceV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';

import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceQuotaFetcher } from './types';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];

describe('ConnectedServiceQuotasCoordinator startup current-source refresh scheduling', () => {
  afterEach(() => {
    invalidateConnectedServiceAccountMode();
  });

  it('deduplicates and bounds startup refresh work inside the quota coordinator', () => {
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {} as QuotaApi,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [{
        serviceId: 'openai-codex',
        fetch: vi.fn(async () => null),
      }],
      now: () => 1,
      randomBytes,
      discoveryEnabled: false,
    });
    const sources = Array.from({ length: 300 }, (_, index) => ({
      serviceId: 'openai-codex' as const,
      profileId: `profile-${index}`,
      bindingKind: 'profile' as const,
    }));

    expect(coordinator.scheduleCurrentSourceRefresh([
      sources[0]!,
      ...sources,
      sources[1]!,
    ])).toEqual({
      accepted: 256,
      ignored: 46,
    });
  });

  it('polls a scheduled missing source without requiring a tracked runtime or discovery', async () => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-cold',
        providerEmail: 'cold@example.test',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'cold-profile', status: 'connected' as const }],
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
      })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'cold-profile',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'cold@example.test',
        meters: [],
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes,
      discoveryEnabled: false,
    });
    const source = {
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      bindingKind: 'profile',
    } satisfies ConnectedServiceUsageSourceV1;

    expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({
      accepted: 1,
      ignored: 0,
    });
    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
    expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({
      accepted: 1,
      ignored: 0,
    });
  });

  it('forces scheduled account-usage source repair even when the separate quota snapshot is fresh', async () => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-cold',
        providerEmail: 'cold@example.test',
      },
    });
    const freshSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      fetchedAt: now - 1_000,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'cold@example.test',
      meters: [],
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'cold-profile', status: 'connected' as const }],
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: freshSnapshot },
        metadata: {
          fetchedAt: freshSnapshot.fetchedAt,
          staleAfterMs: freshSnapshot.staleAfterMs,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
      })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => ({
        ...freshSnapshot,
        fetchedAt: now,
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes,
      discoveryEnabled: false,
    });
    const source = {
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      bindingKind: 'profile',
    } satisfies ConnectedServiceUsageSourceV1;

    coordinator.scheduleCurrentSourceRefresh([source]);
    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });
});
