import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  openConnectedServiceCredentialCiphertext,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';

import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';
import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';

const credentials: Credentials = {
  token: 'happy-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
};

function legacySecret(): Uint8Array {
  if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
  return credentials.encryption.secret;
}

describe('ConnectedServiceRefreshCoordinator.refreshClaudeSubscriptionTokensForBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateConnectedServiceAccountMode();
  });

  it('returns a Claude subscription setup-token as-is (no refresh, no provider call)', async () => {
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro',
      kind: 'token',
      token: { token: 'sk-ant-oat01-setup', providerAccountId: 'anthropic-acct', providerEmail: null },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const fetchMock = vi.fn(async () => { throw new Error('must not refresh a setup-token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: 'anthropic-acct', expiresAt: null },
      })),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'claude-pro' },
    });

    expect(result).toEqual({ accessToken: 'sk-ant-oat01-setup', anthropicAccountId: 'anthropic-acct', expiresAt: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('refreshes Claude subscription OAuth and returns only the rotated access token', async () => {
    const now = 3_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'old-claude-access',
        refreshToken: 'old-claude-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'anthropic-acct',
        providerEmail: 'claude@example.com',
      },
    });
    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'fresh-claude-access', refresh_token: 'rotated-claude-refresh', expires_in: 3600 }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'claude@example.com', providerAccountId: 'anthropic-acct', expiresAt: now + 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'claude-oauth' },
      forceRefresh: true,
    });

    expect(result.accessToken).toBe('fresh-claude-access');
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toContain('rotated-claude-refresh');

    // The rotated refresh token is persisted ONLY in the daemon's sealed store, never returned.
    const opened = openConnectedServiceCredentialCiphertext({
      material: { type: 'legacy', secret: legacySecret() },
      ciphertext: sealedCiphertext,
    });
    expect(opened?.value).toMatchObject({ kind: 'oauth', oauth: expect.objectContaining({ accessToken: 'fresh-claude-access', refreshToken: 'rotated-claude-refresh' }) });
  });

  it('returns the CURRENT access token without rotating when the OAuth token is still valid and forceRefresh is not set (F6)', async () => {
    const now = 4_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      // Far from expiry relative to refreshWindowMs below — the bridge must NOT rotate the single-use
      // refresh token on a cold broker cache-miss.
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'current-valid-access',
        refreshToken: 'current-refresh-MUST-NOT-ROTATE',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'anthropic-acct',
        providerEmail: 'claude@example.com',
      },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const fetchMock = vi.fn(async () => { throw new Error('must not refresh a still-valid token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const acquireLease = vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 }));
    const registerSealed = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'oauth', providerEmail: 'claude@example.com', providerAccountId: 'anthropic-acct', expiresAt: now + 60 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: acquireLease,
      registerConnectedServiceCredentialSealed: registerSealed,
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'claude-oauth' },
      forceRefresh: false,
    });

    expect(result).toEqual({ accessToken: 'current-valid-access', anthropicAccountId: 'anthropic-acct', expiresAt: now + 60 * 60_000 });
    // No provider refresh, no lease acquisition, no rotation/persist.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(registerSealed).not.toHaveBeenCalled();
  });

  it('rotates a still-valid OAuth token when forceRefresh is set (401-retry path, F6)', async () => {
    const now = 5_500_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'stale-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'anthropic-acct',
        providerEmail: 'claude@example.com',
      },
    });
    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'claude@example.com', providerAccountId: 'anthropic-acct', expiresAt: now + 60 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'claude-oauth' },
      forceRefresh: true,
    });

    expect(result.accessToken).toBe('rotated-access');
    expect(fetchMock).toHaveBeenCalled();
  });
});
