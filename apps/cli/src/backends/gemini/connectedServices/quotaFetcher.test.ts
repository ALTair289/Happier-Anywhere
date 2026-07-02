/**
 * X7 — Gemini "connected but quota unknown" placeholder
 *
 * When the daemon-side quota fetcher cannot determine quota, it must surface
 * a snapshot with quota_unknown meters rather than returning null (which
 * produces no display at all).
 */
import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import * as geminiQuotaFetcherModule from './quotaFetcher';
import { createGeminiQuotaFetcher } from './quotaFetcher';

type QuotaDescriptorModule = Readonly<{
  geminiQuotaFetcherDescriptor?: Readonly<{
    loadQuota: (params: Readonly<{
      env: NodeJS.ProcessEnv;
      staleAfterMs: number;
    }>) => ReturnType<typeof createGeminiQuotaFetcher>;
  }>;
}>;

describe('createGeminiQuotaFetcher — X7: quota_unknown placeholder', () => {
  it('exposes a provider-owned descriptor that leaves Gemini quota unsupported as quota_unknown', async () => {
    const descriptor = (geminiQuotaFetcherModule as QuotaDescriptorModule).geminiQuotaFetcherDescriptor;
    expect(descriptor).toBeTruthy();

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'personal',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'tok',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = descriptor!.loadQuota({ env: {}, staleAfterMs: 123_000 });
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    expect(snapshot).toMatchObject({
      serviceId: 'gemini',
      profileId: 'personal',
      meters: [expect.objectContaining({
        status: 'unavailable',
        details: { code: 'quota_unknown' },
      })],
    });
  });

  it('returns a quota_unknown snapshot rather than null when quota cannot be determined', async () => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'personal',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'tok',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createGeminiQuotaFetcher();
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.serviceId).toBe('gemini');
    expect(snapshot?.profileId).toBe('personal');
    // At least one meter must be present (the quota_unknown placeholder)
    expect(Array.isArray(snapshot?.meters)).toBe(true);
    expect(snapshot!.meters.length).toBeGreaterThan(0);
    // All meters must be in unavailable state with a quota_unknown code
    expect(snapshot!.meters.every((m) => m.status === 'unavailable')).toBe(true);
    expect(snapshot!.meters.every((m) => m.details?.code === 'quota_unknown')).toBe(true);
  });

  it('quota_unknown snapshot is valid against the ConnectedServiceQuotaSnapshotV1Schema', async () => {
    const now = 1_000_000;
    const { ConnectedServiceQuotaSnapshotV1Schema, buildConnectedServiceCredentialRecord: buildRecord } =
      await import('@happier-dev/protocol');

    const record = buildRecord({
      now,
      serviceId: 'gemini',
      profileId: 'personal',
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

    const fetcher = createGeminiQuotaFetcher();
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    expect(snapshot).not.toBeNull();
    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
  });
});
