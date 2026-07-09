import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import type { Credentials } from '@/persistence';

const { mockPost, mockGet, mockPatch } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost, get: mockGet, patch: mockPatch, isAxiosError: vi.fn(() => true) },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('./configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
  },
}));

function createTestCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

function createAxiosResponseError(params: Readonly<{
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}>): Error & {
  response: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
} {
  const error = new Error(`Request failed with status ${params.status}`) as Error & {
    response: {
      status: number;
      data: unknown;
      headers: Record<string, string>;
    };
  };
  error.response = {
    status: params.status,
    data: params.data ?? { error: 'request_failed' },
    headers: params.headers ?? {},
  };
  return error;
}

describe('ApiClient connected services v3 credentials', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockPatch.mockReset();
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });

  it('posts plaintext credentials to the v3 connected services endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create(createTestCredentials());
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(typeof (api as unknown as { registerConnectedServiceCredentialPlain?: unknown }).registerConnectedServiceCredentialPlain).toBe('function');
    await (api as unknown as {
      registerConnectedServiceCredentialPlain(params: {
        serviceId: 'openai-codex';
        profileId: string;
        content: { t: 'plain'; v: typeof record };
      }): Promise<void>;
    }).registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({
        content: { t: 'plain', v: record },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('emits a visible diagnostic when the registered profile id diverges from the v3 route profile id', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { profileId: 'other-profile' } });

    const api = await ApiClient.create(createTestCredentials());
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    });

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[API] Connected service credential registration profile mismatch',
      {
        serviceId: 'openai-codex',
        routeProfileId: 'work',
        registeredProfileId: 'other-profile',
      },
    );
    const serializedLogs = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('samples transient plaintext credential registration failures without error-labeled logs', async () => {
    mockPost.mockRejectedValue(createAxiosResponseError({
      status: 503,
      data: { error: 'server_unavailable' },
      headers: { 'retry-after': '3' },
    }));

    const api = await ApiClient.create(createTestCredentials());
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    })).rejects.toThrow('Failed to register connected service credential');
    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    })).rejects.toThrow('Failed to register connected service credential');

    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).toBe(
      '[API] Failed to register connected service credential temporarily unavailable; will retry or recover when the server is ready.',
    );
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'server_error',
        retryable: true,
        statusCode: 503,
        retryAfterMs: 3_000,
      },
    });
    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('uses the canonical v3 refresh lease endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { acquired: true, leaseUntil: 1234 } });

    const api = await ApiClient.create(createTestCredentials());
    const leaseApi = api as unknown as {
      acquireConnectedServiceRefreshLease(params: {
        serviceId: 'openai-codex';
        profileId: string;
        machineId: string;
        ownerId?: string;
        leaseMs: number;
      }): Promise<{ acquired: boolean; leaseUntil: number }>;
    };
    const lease = await leaseApi.acquireConnectedServiceRefreshLease({
      serviceId: 'openai-codex',
      profileId: 'work',
      machineId: 'machine-1',
      ownerId: 'machine-1:daemon-a',
      leaseMs: 10_000,
    });

    expect(lease).toEqual({ acquired: true, leaseUntil: 1234 });
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/refresh-lease'),
      { machineId: 'machine-1', ownerId: 'machine-1:daemon-a', leaseMs: 10_000 },
      expect.any(Object),
    );
  });

  it('posts normalized credential health without credential secrets', async () => {
    mockPatch.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create(createTestCredentials());
    await api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'invalid_grant',
        lastRefreshFailureAt: 1234,
      },
    });

    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential/health'),
      expect.objectContaining({
        health: expect.objectContaining({
          reconnectRequired: true,
          lastRefreshFailureKind: 'invalid_grant',
        }),
      }),
      expect.any(Object),
    );
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('refresh-token');
  });

  it('samples transient credential health update failures without error-labeled logs', async () => {
    mockPatch.mockRejectedValue(createAxiosResponseError({
      status: 429,
      data: { error: 'rate_limited' },
      headers: { 'retry-after': '4' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'network_error',
        lastRefreshFailureAt: 1234,
      },
    })).rejects.toThrow('Failed to update connected service credential health');
    await expect(api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'network_error',
        lastRefreshFailureAt: 1234,
      },
    })).rejects.toThrow('Failed to update connected service credential health');

    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).toBe(
      '[API] Failed to update connected service credential health temporarily unavailable; will retry or recover when the server is ready.',
    );
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'rate_limited',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 4_000,
      },
    });
  });
});
