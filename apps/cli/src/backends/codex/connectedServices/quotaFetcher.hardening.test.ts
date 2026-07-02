/**
 * X2 — Richer Codex quota error classification
 * X8 — Stale-but-usable quota (kill-switch path returns quota_unknown)
 * Kill-switch — HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT=1
 *
 * These tests assert on STABLE machine codes, not free-text messages.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ConnectedServiceQuotaFetchError } from '@/daemon/connectedServices/quotas/types';
import { createOpenAiCodexQuotaFetcher } from './quotaFetcher';

const BASE_RECORD_PARAMS = {
  now: 1_000_000,
  serviceId: 'openai-codex' as const,
  profileId: 'work',
  kind: 'oauth' as const,
  expiresAt: 1_060_000,
  oauth: {
    accessToken: 'tok',
    refreshToken: 'rt',
    idToken: null,
    scope: null,
    tokenType: null,
    providerAccountId: 'acct',
    providerEmail: 'user@example.com',
  },
};

function buildRecord() {
  return buildConnectedServiceCredentialRecord(BASE_RECORD_PARAMS);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createOpenAiCodexQuotaFetcher — X2: richer error classification', () => {
  it('emits quotaFetchErrorCode=auth_failure for 401 responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: { get: () => null },
    })) as unknown as typeof fetch);

    const fetcher = createOpenAiCodexQuotaFetcher();
    const error = await fetcher.fetch({ record: buildRecord(), now: 1_000_000, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectedServiceQuotaFetchError);
    expect((error as ConnectedServiceQuotaFetchError).quotaFetchErrorCode).toBe('auth_failure');
    expect((error as ConnectedServiceQuotaFetchError).status).toBe(401);
  });

  it('emits quotaFetchErrorCode=missing_auth when record kind is not oauth', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'tok',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher();
    const error = await fetcher.fetch({ record, now: 1_000_000, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectedServiceQuotaFetchError);
    expect((error as ConnectedServiceQuotaFetchError).quotaFetchErrorCode).toBe('missing_auth');
  });

  it('emits quotaFetchErrorCode=network when fetch throws a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);

    const fetcher = createOpenAiCodexQuotaFetcher();
    const error = await fetcher.fetch({ record: buildRecord(), now: 1_000_000, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectedServiceQuotaFetchError);
    expect((error as ConnectedServiceQuotaFetchError).quotaFetchErrorCode).toBe('network');
    expect((error as ConnectedServiceQuotaFetchError).status).toBeNull();
  });

  it('emits quotaFetchErrorCode=malformed when response body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
      headers: { get: () => null },
    })) as unknown as typeof fetch);

    const fetcher = createOpenAiCodexQuotaFetcher();
    const error = await fetcher.fetch({ record: buildRecord(), now: 1_000_000, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectedServiceQuotaFetchError);
    expect((error as ConnectedServiceQuotaFetchError).quotaFetchErrorCode).toBe('malformed');
  });

  it('emits quotaFetchErrorCode=provider_backoff for 429 with Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '60' : null },
    })) as unknown as typeof fetch);

    const fetcher = createOpenAiCodexQuotaFetcher();
    const error = await fetcher.fetch({ record: buildRecord(), now: 1_000_000, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectedServiceQuotaFetchError);
    expect((error as ConnectedServiceQuotaFetchError).quotaFetchErrorCode).toBe('provider_backoff');
    expect((error as ConnectedServiceQuotaFetchError).retryAfterMs).toBe(60_000);
  });

  it('emits quotaFetchErrorCode=provider_backoff for 5xx server errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: { get: () => null },
    })) as unknown as typeof fetch);

    const fetcher = createOpenAiCodexQuotaFetcher();
    const error = await fetcher.fetch({ record: buildRecord(), now: 1_000_000, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectedServiceQuotaFetchError);
    expect((error as ConnectedServiceQuotaFetchError).quotaFetchErrorCode).toBe('provider_backoff');
  });

  it('carries provider_code field from response body when present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
      json: async () => ({ code: 'ACCOUNT_SUSPENDED' }),
    })) as unknown as typeof fetch);

    const fetcher = createOpenAiCodexQuotaFetcher();
    const error = await fetcher.fetch({ record: buildRecord(), now: 1_000_000, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectedServiceQuotaFetchError);
    expect((error as ConnectedServiceQuotaFetchError).quotaFetchErrorCode).toBe('provider_backoff');
    expect((error as ConnectedServiceQuotaFetchError).providerCode).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('createOpenAiCodexQuotaFetcher — kill-switch: HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT', () => {
  it('returns quota_unknown snapshot without calling fetch when kill-switch is active', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetcher = createOpenAiCodexQuotaFetcher({ disablePrivateEndpoint: true });
    const snapshot = await fetcher.fetch({ record: buildRecord(), now: 1_000_000, signal: new AbortController().signal });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.serviceId).toBe('openai-codex');
    expect(snapshot?.meters.every((m) => m.status === 'unavailable')).toBe(true);
    expect(snapshot?.meters.every((m) => m.details?.code === 'quota_unknown')).toBe(true);
  });

  it('still uses the per-call usageUrl override even when disablePrivateEndpoint is false', async () => {
    const customUrl = 'https://my-proxy.example.com/usage';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 42, reset_at: 1700000000 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetcher = createOpenAiCodexQuotaFetcher({ usageUrl: customUrl, disablePrivateEndpoint: false });
    await fetcher.fetch({ record: buildRecord(), now: 1_000_000, signal: new AbortController().signal });

    expect(fetchMock).toHaveBeenCalledWith(customUrl, expect.anything());
  });
});
