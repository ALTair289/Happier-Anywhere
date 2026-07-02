import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { openConnectedServiceCredentialCiphertext } from '@happier-dev/protocol';
import { ConnectedServiceCredentialRecordV1Schema } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import {
  classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh,
  ConnectedServiceRefreshCoordinator,
} from './ConnectedServiceRefreshCoordinator';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { normalizeMaterializationKeyForPath } from '../materialize/normalizeMaterializationKeyForPath';

function resolveCodexHomeForMaterialization(baseDir: string, materializationKey: string): string {
  return join(baseDir, normalizeMaterializationKeyForPath(materializationKey), 'codex', 'codex-home');
}

describe('ConnectedServiceRefreshCoordinator', () => {
  it('keeps provider-specific materialization diagnostic codes out of the generic refresh coordinator', async () => {
    const source = await readFile(new URL('./ConnectedServiceRefreshCoordinator.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('claude_subscription_');
    expect(source).not.toContain('resolveMissingClaude');
    expect(source).not.toContain('missing_claude_code_scope');
  });

  it('classifies materialization diagnostics without turning local runtime-home failures into provider 403', () => {
    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_missing_claude_code_scope',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_required_scope',
      credentialRefreshFailure: {
        category: 'provider_403',
        providerStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      },
    })).toEqual({
      category: 'provider_403',
      providerStatus: 403,
      providerErrorCode: 'claude_subscription_missing_claude_code_scope',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'credential_file_write_failed',
    })).toEqual({
      category: 'unknown',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_access_token',
      credentialRefreshFailure: {
        category: 'missing_access_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      },
    })).toEqual({
      category: 'missing_access_token',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_refresh_token',
      credentialRefreshFailure: {
        category: 'missing_refresh_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      },
    })).toEqual({
      category: 'missing_refresh_token',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_keychain_write_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'keychain_write_failed',
    })).toEqual({
      category: 'unknown',
      providerErrorCode: 'claude_subscription_native_auth_keychain_write_failed',
    });
  });

  it('refreshes an expiring openai-codex credential and re-materializes for active spawn targets', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const legacySecret = credentials.encryption.secret;

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

	    const api = {
	      getConnectedServiceCredentialSealed: vi.fn(async () => ({
	        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
	        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
	      })),
	      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
	      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
	        sealedCiphertext = params.sealed.ciphertext;
	      }),
	      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
	    } as unknown as ApiClient;

	    const fetchMock = vi.fn(async () => ({
	      ok: true,
	      json: async () => ({
	        access_token: 'new-access',
	        refresh_token: 'new-refresh',
	        id_token: 'new-id',
	        expires_in: 3600,
	      }),
	    }));
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      logRefreshDiagnostic: vi.fn(),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-1');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'connected',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshSuccessAt: now,
      },
    });
  });

  it('refreshes plaintext credentials through the plaintext credential endpoint', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-plain-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-plain-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: storedRecord } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
      }),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-plain',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 456,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-plain',
    });

    await coordinator.tickOnce();

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(typedApi.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(storedRecord.oauth?.accessToken).toBe('new-access');

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-plain');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('falls back to plaintext credentials when the account-mode probe errors', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-plain-fallback-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-plain-fallback-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: storedRecord } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
      }),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-plain-fallback',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 456,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-plain-fallback',
    });

    await coordinator.tickOnce();

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(typedApi.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(storedRecord.oauth?.accessToken).toBe('new-access');

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-plain-fallback');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('falls back to sealed credentials when the account-mode probe errors and plaintext read fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-sealed-fallback-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-sealed-fallback-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const legacySecret = credentials.encryption.secret;

    const now = 1_000_000;
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload: storedRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        throw new Error('plain read failed');
      }),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
        const opened = openConnectedServiceCredentialCiphertext({
          material: { type: 'legacy', secret: legacySecret },
          ciphertext: params.sealed.ciphertext,
        });
        if (!opened?.value) throw new Error('expected opened record');
        storedRecord = ConnectedServiceCredentialRecordV1Schema.parse(opened.value);
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-sealed-fallback',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 456,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-sealed-fallback',
    });

    await coordinator.tickOnce();

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
    expect(storedRecord.oauth?.accessToken).toBe('new-access');

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-sealed-fallback');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('uses active account settings when refresh re-materializes Codex auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-refresh-'));
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sourceCodexHome;
    try {
      const coordinatorParams = {
        api,
        credentials,
        machineIdProvider: () => 'machine-1',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => now,
        accountSettingsProvider: () => ({
          connectedServicesProviderStateSharingSettingsV1: {
            v: 1,
            defaults: {
              configMode: 'isolated',
              stateMode: 'isolated',
            },
            byAgentId: {},
            acknowledgedRisksByAgentId: {},
          },
        }),
        processEnv: process.env,
      };
      const coordinator = new ConnectedServiceRefreshCoordinator(coordinatorParams);

      coordinator.registerSpawnTarget({
        pid: 123,
        agentId: 'codex',
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
        },
        materializationKey: 'session-1',
      });

      await coordinator.tickOnce();

      const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-1');
      const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
      expect(auth.access_token).toBe('new-access');
      await expect(lstat(join(codexHome, 'config.toml'))).rejects.toThrow();
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it('invokes onAuthUpdated callback with affected targets after refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

	    const api = {
	      getConnectedServiceCredentialSealed: vi.fn(async () => ({
	        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
	        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
	      })),
	      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
	      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
	        sealedCiphertext = params.sealed.ciphertext;
	      }),
	    } as unknown as ApiClient;

	    const fetchMock = vi.fn(async () => ({
	      ok: true,
	      json: async () => ({
	        access_token: 'new-access',
	        refresh_token: 'new-refresh',
	        id_token: 'new-id',
	        expires_in: 3600,
	      }),
	    }));
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'pi',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'pi' })],
    }));
  });

  it('rematerializes affected local targets when an external credential update is observed', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-update-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-update-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'reconnected-access',
        refreshToken: 'reconnected-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
    } as unknown as ApiClient;

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-openai',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'openai-codex'; profileId: string }>) => Promise<void>;
    };
    expect(externalUpdate.handleExternalCredentialUpdate).toBeTypeOf('function');

    await externalUpdate.handleExternalCredentialUpdate!({ serviceId: 'openai-codex', profileId: 'work' });

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-openai');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('reconnected-access');
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'codex' })],
    }));
  });

  it('rematerializes into the live identity root instead of an orphan sha256 root for identity-keyed targets (RD-MAT-6)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-identity-root-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-identity-root-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    // The spawn registers `materializationKey = identity.id` (csm_*). The session reads
    // `<baseDir>/<identity.id>/codex/...`; a rematerialization that drops the identity falls back
    // to sha256(key) and writes fresh credentials into an orphan root no session ever reads.
    const identityId = `csm_${'a'.repeat(32)}`;
    coordinator.registerSpawnTarget({
      pid: 124,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: identityId,
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'openai-codex'; profileId: string }>) => Promise<void>;
    };
    await externalUpdate.handleExternalCredentialUpdate!({ serviceId: 'openai-codex', profileId: 'work' });

    const liveIdentityHome = join(baseDir, identityId, 'codex', 'codex-home');
    const auth = JSON.parse(await readFile(join(liveIdentityHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('rotated-access');
    // No orphan sha256(csm_*) root may be created for an identity-keyed target.
    const orphanHome = resolveCodexHomeForMaterialization(baseDir, identityId);
    await expect(lstat(orphanHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rematerializes with the tracked session directory so Claude workspace trust targets the session cwd (RD-MAT-6)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-session-dir-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-session-dir-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-connected-services-project-'));

    // The user's own home carries the trust grant for the session directory; the refresh-driven
    // rematerialization must project it into the target home FOR THAT DIRECTORY — not for the
    // daemon's cwd, which is what a sessionDirectory-less rematerialization falls back to.
    await writeFile(join(sourceHomeDir, '.claude.json'), JSON.stringify({
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
    }));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'trusted-access',
        refreshToken: 'trusted-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-trust',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'claude-subscription'; profileId: string }>) => Promise<void>;
    };
    await externalUpdate.handleExternalCredentialUpdate!({ serviceId: 'claude-subscription', profileId: 'work' });

    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    const rootConfig = JSON.parse(await readFile(join(stableConfigDir, '.claude.json'), 'utf8'));
    expect(rootConfig.projects?.[sessionDirectory]).toMatchObject({ hasTrustDialogAccepted: true });
  });

  it('rematerializes active Claude homes after a runtime-auth forced refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-remat-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-remat-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-connected-services-project-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      // Far outside the scheduled refresh window: this must still rotate and rematerialize because
      // provider 401 proof is stronger than source-side expiry metadata.
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'runtime-access',
        refresh_token: 'runtime-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    expect(result.status).toBe('refreshed');
    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    const credential = JSON.parse(await readFile(join(stableConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('runtime-access');
    expect(credential.claudeAiOauth.refreshToken).toBe('runtime-refresh');
    expect(credential.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile', 'user:sessions:claude_code']);
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 125, agentId: 'claude' })],
      trigger: 'refresh_triggered_restart',
    });
  });

  it('reports runtime-auth refresh as failed when the failing active Claude home cannot be rematerialized', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-remat-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-remat-blocked-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-blocked-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'runtime-access-without-claude-code',
        refresh_token: 'runtime-refresh',
        // Missing user:sessions:claude_code must block active-home rematerialization.
        scope: 'user:inference user:profile',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      sessionId: 'sess_1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      sessionId: 'sess_1',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'refresh_failed',
      diagnostic: expect.objectContaining({
        serviceId: 'claude-subscription',
        profileId: 'work',
        reason: 'runtime_auth_failure',
        status: 'refresh_failed',
        category: 'provider_403',
        providerStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
  });

  it('reports runtime-auth refresh as failed when the requested live session has no registered rematerialization target', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-missing-target-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-missing-target-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now - 1_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'codex',
      sessionId: 'sess_other',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'primary' } },
      },
      materializationKey: 'session-codex-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'openai-codex',
      profileId: 'primary',
      sessionId: 'sess_missing',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'refresh_failed',
      diagnostic: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'primary',
        reason: 'runtime_auth_failure',
        status: 'refresh_failed',
        category: 'unknown',
        providerErrorCode: 'runtime_auth_target_not_registered',
      }),
    }));
    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      health: expect.objectContaining({
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshFailureKind: 'unknown',
        providerErrorCode: 'runtime_auth_target_not_registered',
      }),
    });
  });

  it('does not restart affected Claude targets when external credential rematerialization is blocking', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-update-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-update-blocked-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'claude-subscription'; profileId: string }>) => Promise<void>;
    };
    expect(externalUpdate.handleExternalCredentialUpdate).toBeTypeOf('function');

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await externalUpdate.handleExternalCredentialUpdate!({ serviceId: 'claude-subscription', profileId: 'work' });
      expect(warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Connected-service rematerialization blocked; skipping auth-update restart',
        expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: 'work',
          agentId: 'claude',
          materializationCode: 'claude_subscription_missing_claude_code_scope',
        }),
      );
    } finally {
      warn.mockRestore();
    }

    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('narrow-refresh');
  });

  it('does not restart a multi-service target when any rematerialized binding is blocking', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-update-multi-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-update-multi-blocked-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const legacySecret = credentials.encryption.secret;

    const now = 1_000_000;
    const codexRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'codex-access',
        refreshToken: 'codex-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'codex-acct',
        providerEmail: null,
      },
    });
    const claudeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'claude-narrow-access',
        refreshToken: 'claude-narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });
    const seal = (payload: typeof codexRecord | typeof claudeRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByKey = new Map([
      ['openai-codex/work', seal(codexRecord)],
      ['claude-subscription/claude-work', seal(claudeRecord)],
    ]);
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        const ciphertext = ciphertextByKey.get(`${params.serviceId}/${params.profileId}`);
        if (!ciphertext) return null;
        const record = params.serviceId === 'openai-codex' ? codexRecord : claudeRecord;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: null,
            providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : null,
            expiresAt: record.expiresAt,
          },
        };
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
          'claude-subscription': { source: 'connected', profileId: 'claude-work' },
        },
      },
      materializationKey: 'session-claude',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'openai-codex'; profileId: string }>) => Promise<void>;
    };
    expect(externalUpdate.handleExternalCredentialUpdate).toBeTypeOf('function');

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await externalUpdate.handleExternalCredentialUpdate!({ serviceId: 'openai-codex', profileId: 'work' });
    } finally {
      warn.mockRestore();
    }

    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('claude-narrow-refresh');
  });

  it('clears a stale id token but preserves friendly account email when the refresh response omits id_token', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'stale-id-token',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'known-user@example.test',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'known-user@example.test', providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    const opened = openConnectedServiceCredentialCiphertext({
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: sealedCiphertext,
    });
    expect(opened?.value).toMatchObject({
      kind: 'oauth',
      oauth: expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: null,
        providerEmail: 'known-user@example.test',
      }),
    });
  });

  it('directly refreshes a Codex group active profile and updates only the group-home bridge response', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 90_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'alice@example.com', providerAccountId: 'chatgpt-account', expiresAt: now + 90_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        fallbackProfileId: 'work',
        generation: 7,
      },
      chatgptPlanType: 'plus',
      // Exercise the rotation path explicitly (F6: rotation now requires near-expiry OR force).
      forceRefresh: true,
    });

    expect(result).toEqual({
      accessToken: 'new-access',
      chatgptAccountId: 'chatgpt-account',
      chatgptPlanType: 'plus',
    });
    expect(result).not.toHaveProperty('refreshToken');
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
      machineId: 'machine-1',
      ownerId: 'machine-1:daemon-a',
      leaseMs: 30_000,
    });

    const opened = openConnectedServiceCredentialCiphertext({
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: sealedCiphertext,
    });
    expect(opened?.value).toMatchObject({
      kind: 'oauth',
      oauth: expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'rotated-refresh',
      }),
    });

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'openai-codex-refresh-backup');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
    expect(auth.refresh_token).toBe('rotated-refresh');
  });

  it('refreshes Codex bridge tokens into the registered target materialized home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-target-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-bridge-target-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 90_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'alice@example.com', providerAccountId: 'chatgpt-account', expiresAt: now + 90_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'happy-session-bridge',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-bridge',
    });

    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      chatgptPlanType: 'team',
      forceRefresh: true,
    });

    expect(result).toEqual({
      accessToken: 'new-access',
      chatgptAccountId: 'chatgpt-account',
      chatgptPlanType: 'team',
    });
    const activeCodexHome = resolveCodexHomeForMaterialization(baseDir, 'session-bridge');
    const activeAuth = JSON.parse(await readFile(join(activeCodexHome, 'auth.json'), 'utf8'));
    expect(activeAuth.access_token).toBe('new-access');
    expect(activeAuth.refresh_token).toBe('rotated-refresh');
    await expect(lstat(resolveCodexHomeForMaterialization(baseDir, 'openai-codex-refresh-work'))).rejects.toThrow();
  });

  it('returns the CURRENT Codex access token without rotating when valid and forceRefresh is not set (F6)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-noforce-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-bridge-noforce-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      // Far from expiry vs refreshWindowMs below — must NOT rotate the single-use refresh token.
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'current-codex-access',
        refreshToken: 'current-codex-refresh-MUST-NOT-ROTATE',
        idToken: 'id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const acquireLease = vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 }));
    const registerSealed = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'oauth', providerEmail: 'alice@example.com', providerAccountId: 'chatgpt-account', expiresAt: now + 60 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: acquireLease,
      registerConnectedServiceCredentialSealed: registerSealed,
    } as unknown as ApiClient;
    const fetchMock = vi.fn(async () => { throw new Error('must not refresh a still-valid token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: false,
    });

    expect(result).toEqual({ accessToken: 'current-codex-access', chatgptAccountId: 'chatgpt-account', chatgptPlanType: 'plus' });
    // No provider refresh, no lease, no rotation/persist when the token is still valid.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(registerSealed).not.toHaveBeenCalled();
  });

  it('waits and re-reads credentials when another daemon owns the refresh lease for spawn preflight', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-lease-wait-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-lease-wait-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(15) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const staleRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const refreshedRecord = buildConnectedServiceCredentialRecord({
      now: now + 50,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'other-daemon-access',
        refreshToken: 'other-daemon-refresh',
        idToken: 'other-daemon-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const staleCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: staleRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: refreshedRecord,
      randomBytes: (length) => randomBytes(length),
    });

    let credentialReads = 0;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        credentialReads += 1;
        const ciphertext = credentialReads === 1 ? staleCiphertext : refreshedCiphertext;
        const expiresAt = credentialReads === 1 ? staleRecord.expiresAt : refreshedRecord.expiresAt;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: 'user@example.com', providerAccountId: 'acct', expiresAt },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: false, leaseUntil: now + 50 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    const sleepMs = vi.fn(async () => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      leaseContentionWaitMaxMs: 100,
      sleepMs,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refreshed');
    expect(result.credential).toMatchObject({
      kind: 'oauth',
      oauth: expect.objectContaining({ accessToken: 'other-daemon-access' }),
    });
    expect(sleepMs).toHaveBeenCalledWith(50);
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledTimes(2);
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes forced refreshes for the same binding inside one daemon process', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-singleflight-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-singleflight-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const first = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });
    const second = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(firstResult?.oauth?.accessToken).toBe('new-access');
    expect(secondResult?.oauth?.accessToken).toBe('new-access');
  });

  it('does not satisfy a forced refresh from an in-flight non-forced not-needed refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-force-class-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-force-class-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    let releaseCredentialRead: () => void = () => {};
    const credentialReadReleased = new Promise<void>((resolve) => {
      releaseCredentialRead = resolve;
    });
    let resolveCredentialReadStarted: () => void = () => {};
    const credentialReadStarted = new Promise<void>((resolve) => {
      resolveCredentialReadStarted = resolve;
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        resolveCredentialReadStarted();
        await credentialReadReleased;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'forced-access',
        refresh_token: 'forced-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    const nonForced = coordinator.tickOnce();
    await credentialReadStarted;
    const forced = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });
    releaseCredentialRead();

    const [, forcedResult] = await Promise.all([nonForced, forced]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(forcedResult?.oauth?.accessToken).toBe('forced-access');
  });

  it('coalesces a concurrent forced and non-forced refresh of the same near-expiry binding into one rotation', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-coalesce-rotation-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-coalesce-rotation-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    // Near-expiry inside the refresh window so the NON-forced refresh actually performs a network rotation.
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'rt0',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    // Each refresh-token POST rotates: rt0 -> rt1 (only the FIRST POST is honored). A second concurrent
    // POST presenting the already-consumed rt0 would mint a superseded token. We assert it never happens.
    const issuedRefreshTokens = new Set<string>();
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const tokenSuffix = issuedRefreshTokens.size + 1;
      issuedRefreshTokens.add(`rt${tokenSuffix}`);
      return {
        ok: true,
        json: async () => ({
          access_token: `access-${tokenSuffix}`,
          refresh_token: `rt${tokenSuffix}`,
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    const nonForced = coordinator.tickOnce();
    const forced = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    const [, forcedResult] = await Promise.all([nonForced, forced]);

    // Exactly ONE network rotation and ONE lease acquisition for the shared binding.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
    // The forced caller adopts the single coalesced rotation rather than racing a second one.
    expect(forcedResult.status).toBe('refreshed');
    expect(forcedResult.credential?.kind).toBe('oauth');
    expect(forcedResult.credential?.oauth?.accessToken).toBe('access-1');
  });

  it('runs a forced refresh after an in-flight forced refresh adopts the first rotation', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-forced-join-forced-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-forced-join-forced-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      // Far-future expiry: a non-forced refresh would early-return not_needed; both callers here are forced.
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'rt0',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        json: async () => ({ access_token: 'access-1', refresh_token: 'rt1', expires_in: 3600 }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const first = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
    const second = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(firstResult.credential?.oauth?.accessToken).toBe('access-1');
    expect(secondResult.credential?.oauth?.accessToken).toBe('access-1');
  });

  it('still allows a sequential forced refresh after a prior refresh completes', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-sequential-forced-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-sequential-forced-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'rt0',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    let rotation = 0;
    const fetchMock = vi.fn(async () => {
      rotation += 1;
      const current = rotation;
      return {
        ok: true,
        json: async () => ({ access_token: `access-${current}`, refresh_token: `rt${current}`, expires_in: 3600 }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const firstResult = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
    const secondResult = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    // Two fully sequential forced refreshes (no overlap) each perform their own rotation.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstResult.credential?.oauth?.accessToken).toBe('access-1');
    expect(secondResult.credential?.oauth?.accessToken).toBe('access-2');
  });

  it('refreshes distinct bindings concurrently without cross-binding serialization', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-distinct-bindings-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-distinct-bindings-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const recordFor = (profileId: string) => buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId,
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: `old-access-${profileId}`,
        refreshToken: `rt0-${profileId}`,
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const sealedByProfile = new Map<string, string>([
      ['work', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: recordFor('work'),
        randomBytes: (length) => randomBytes(length),
      })],
      ['home', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: recordFor('home'),
        randomBytes: (length) => randomBytes(length),
      })],
    ]);

    let concurrentReads = 0;
    let maxConcurrentReads = 0;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { profileId: string }) => {
        concurrentReads += 1;
        maxConcurrentReads = Math.max(maxConcurrentReads, concurrentReads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentReads -= 1;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedByProfile.get(params.profileId)! },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10_000 },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { profileId: string; sealed: { ciphertext: string } }) => {
        sealedByProfile.set(params.profileId, params.sealed.ciphertext);
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const [resultWork, resultHome] = await Promise.all([
      coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({ serviceId: 'claude-subscription', profileId: 'work' }),
      coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({ serviceId: 'claude-subscription', profileId: 'home' }),
    ]);

    expect(resultWork.status).toBe('refreshed');
    expect(resultHome.status).toBe('refreshed');
    expect(maxConcurrentReads).toBe(2);
  });

  it('propagates a refresh rejection to every coalesced joiner of the same binding', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-error-propagation-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-error-propagation-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'rt0',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('credential read exploded');
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    void sealedCiphertext;

    vi.stubGlobal('fetch', vi.fn() as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const first = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({ serviceId: 'claude-subscription', profileId: 'work' });
    const second = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({ serviceId: 'claude-subscription', profileId: 'work' });

    await expect(first).rejects.toThrow('credential read exploded');
    await expect(second).rejects.toThrow('credential read exploded');
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('persists reauth-required credential health for invalid provider refresh grants without raw provider bodies', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-invalid-grant-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-invalid-grant-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'secret-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'bad request',
      text: async () => JSON.stringify({ error: 'invalid_grant', refresh_token: 'secret-refresh-token' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const logRefreshDiagnostic = vi.fn();
    const onCredentialHealthNotification = vi.fn(async () => {
      throw new AxiosError('notification unavailable Authorization: Bearer SECRET', 'ECONNRESET', {
        method: 'post',
        url: 'https://api.example.test/health?token=SECRET',
        headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }),
        data: { refresh_token: 'secret-refresh-token' },
      });
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    let result: Awaited<ReturnType<ConnectedServiceRefreshCoordinator['refreshConnectedServiceCredentialForQuota']>> | undefined;
    try {
      const coordinator = new ConnectedServiceRefreshCoordinator({
        api,
        credentials,
        machineIdProvider: () => 'machine-1',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => now,
        logRefreshDiagnostic,
        onCredentialHealthNotification,
      } as unknown as ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]);

      const targetRegistration = {
        pid: 123,
        agentId: 'codex',
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
        },
        materializationKey: 'materialization-identity-1',
        sessionId: 'happy-session-1',
      } as Parameters<ConnectedServiceRefreshCoordinator['registerSpawnTarget']>[0] & {
        sessionId: string;
      };
      coordinator.registerSpawnTarget(targetRegistration);

      result = await coordinator.refreshConnectedServiceCredentialForQuota({
        serviceId: 'openai-codex',
        profileId: 'work',
        force: true,
      });

      expect(warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to dispatch connected-service credential health notification',
        expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'work',
          status: 'refresh_failed',
          category: 'invalid_grant',
        }),
      );
      expect(debug).not.toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to dispatch connected-service credential health notification',
        expect.anything(),
      );
      const warned = JSON.stringify(warn.mock.calls);
      expect(warned).not.toContain('Bearer SECRET');
      expect(warned).not.toContain('secret-refresh-token');
      expect(warned).not.toContain('"headers"');
      expect(warned).not.toContain('"data"');
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }

    expect(result).toBeNull();
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'invalid_grant',
        providerHttpStatus: 400,
        providerErrorCode: 'invalid_grant',
      },
    });
    expect(logRefreshDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'work',
      reason: 'quota_bridge',
      status: 'refresh_failed',
      category: 'invalid_grant',
      providerStatus: 400,
      providerErrorCode: 'invalid_grant',
      expiryAgeMs: -600_000,
      refreshWindowMs: 60_000,
    }));
    expect(onCredentialHealthNotification).toHaveBeenCalledWith(expect.objectContaining({
      diagnostic: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        status: 'refresh_failed',
        category: 'invalid_grant',
        providerStatus: 400,
        providerErrorCode: 'invalid_grant',
      }),
      healthStatus: 'reconnect_required',
      affectedTargets: [expect.objectContaining({
        pid: 123,
        agentId: 'codex',
        sessionId: 'happy-session-1',
      })],
    }));
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('secret-refresh-token');
    expect(JSON.stringify(logRefreshDiagnostic.mock.calls)).not.toContain('secret-refresh-token');
    expect(JSON.stringify(onCredentialHealthNotification.mock.calls)).not.toContain('secret-refresh-token');
  });

  it('warns when credential health persistence fails after refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-health-warn-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-health-warn-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'secret-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {
        throw new AxiosError('health write unavailable Authorization: Bearer SECRET', 'ECONNRESET', {
          method: 'post',
          url: 'https://api.example.test/health?token=SECRET',
          headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }),
          data: { refresh_token: 'secret-refresh-token' },
        });
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'bad request',
      text: async () => JSON.stringify({ error: 'invalid_grant', refresh_token: 'secret-refresh-token' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      const coordinator = new ConnectedServiceRefreshCoordinator({
        api,
        credentials,
        machineIdProvider: () => 'machine-1',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => now,
      } as unknown as ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]);

      await expect(coordinator.refreshConnectedServiceCredentialForQuota({
        serviceId: 'openai-codex',
        profileId: 'work',
        force: true,
      })).resolves.toBeNull();

      expect(warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to update connected-service credential health after refresh',
        expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'work',
          status: 'refresh_failed',
          category: 'invalid_grant',
        }),
      );
      expect(debug).not.toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to update connected-service credential health after refresh',
        expect.anything(),
      );
      const warned = JSON.stringify(warn.mock.calls);
      expect(warned).not.toContain('Bearer SECRET');
      expect(warned).not.toContain('secret-refresh-token');
      expect(warned).not.toContain('"headers"');
      expect(warned).not.toContain('"data"');
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  it('does not retry scheduled refresh for profiles already marked reconnect-required', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-needs-reauth-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-needs-reauth-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'invalid-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work',
          status: 'needs_reauth' as const,
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 30_000,
        }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => {
      throw new Error('scheduled refresh should not reach provider for reconnect-required credentials');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await expect(coordinator.tickOnce()).resolves.toBeUndefined();

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.updateConnectedServiceCredentialHealth).not.toHaveBeenCalled();
  });

  it('returns reconnect-required from spawn preflight before the expiry-window shortcut', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-spawn-health-gate-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-spawn-health-gate-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'invalid-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work',
          status: 'needs_reauth' as const,
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => {
      throw new Error('spawn preflight should not reach provider for reconnect-required credentials');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refresh_failed');
    expect(result.diagnostic).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'work',
      reason: 'spawn_preflight',
      category: 'invalid_grant',
      expiresAt: now + 10 * 60_000,
    }));
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors forced Claude spawn preflight refresh for future-dated OAuth credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-forced-claude-spawn-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-forced-claude-spawn-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'claude-subscription',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: now + 10 * 60_000,
        oauth: {
          accessToken: 'future-access',
          refreshToken: 'future-refresh',
          idToken: null,
          scope: 'user:inference user:profile user:sessions:claude_code',
          tokenType: 'Bearer',
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'forced-access',
        refresh_token: 'forced-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });

    expect(result.status).toBe('refreshed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(result.credential?.kind).toBe('oauth');
    if (!result.credential || result.credential.kind !== 'oauth') {
      throw new Error('expected oauth credential');
    }
    expect(result.credential.oauth.accessToken).toBe('forced-access');
  });

  it('redacts profile-health read failures before refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-spawn-health-read-redaction-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-spawn-health-read-redaction-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => {
        throw new AxiosError('Request failed with Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
          method: 'get',
          url: 'https://api.example.test/v3/connect/openai-codex/profiles?token=QUERY_SECRET',
          headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
          data: { access_token: 'BODY_SECRET' },
        });
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toEqual(expect.objectContaining({ status: 'not_needed' }));

    const payload = JSON.stringify(warnSpy.mock.calls.at(-1)?.[1]);
    expect(payload).toContain('https://api.example.test/v3/connect/openai-codex/profiles');
    expect(payload).not.toContain('MESSAGE_SECRET');
    expect(payload).not.toContain('QUERY_SECRET');
    expect(payload).not.toContain('HEADER_SECRET');
    expect(payload).not.toContain('BODY_SECRET');
    expect(payload).not.toContain('"headers"');
    expect(payload).not.toContain('"data"');
  });

  it('does not quota-bridge refresh cached reconnect-required credentials when forced', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-quota-health-gate-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-quota-health-gate-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'invalid-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work',
          status: 'needs_reauth' as const,
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => {
      throw new Error('quota bridge should not reach provider for reconnect-required credentials');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes the active group profile and re-materializes the selected group home for tracked group spawn targets', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'alice@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        if (params.serviceId !== 'openai-codex' || params.profileId !== 'backup') {
          return null;
        }
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: 'alice@example.com',
            providerAccountId: 'acct',
            expiresAt: now + 30_000,
          },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const targetRegistration = {
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            profileId: 'work',
            groupId: 'main',
          },
        },
      },
      materializationKey: 'session-1',
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'work',
          generation: 7,
        }]),
      },
    } as Parameters<ConnectedServiceRefreshCoordinator['registerSpawnTarget']>[0] & {
      connectedServiceSelectionsEnv: Record<string, string>;
    };

    coordinator.registerSpawnTarget(targetRegistration);

    await coordinator.tickOnce();

    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-1');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
    expect(auth.refresh_token).toBe('new-refresh');
  });

  it('continues refreshing other bindings when one binding refresh fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const openaiRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const geminiRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'g-old-access',
        refreshToken: 'g-old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const sealedByServiceId = new Map<string, string>();
    sealedByServiceId.set('openai-codex', sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: openaiRecord,
      randomBytes: (length) => randomBytes(length),
    }));
    sealedByServiceId.set('gemini', sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: geminiRecord,
      randomBytes: (length) => randomBytes(length),
    }));

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string }) => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedByServiceId.get(params.serviceId)! },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: null, expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; sealed: { ciphertext: string } }) => {
        sealedByServiceId.set(params.serviceId, params.sealed.ciphertext);
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('auth.openai.com')) {
        return { ok: false, status: 500, statusText: 'fail', text: async () => 'boom' } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'g-new-access',
          refresh_token: 'g-new-refresh',
          expires_in: 3600,
        }),
        text: async () => '',
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const logRefreshDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      logRefreshDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 1,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-openai',
    });
    coordinator.registerSpawnTarget({
      pid: 2,
      agentId: 'gemini',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { gemini: { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-gemini',
    });

    await expect(coordinator.tickOnce()).rejects.toThrow();

    // Even though OpenAI refresh failed, Gemini should still have been refreshed and registered.
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'gemini' }));
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'unknown',
        providerHttpStatus: 500,
      },
    });
    expect(logRefreshDiagnostic).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      reason: 'scheduled',
      status: 'refresh_failed',
      category: 'unknown',
      providerStatus: 500,
      providerErrorCode: null,
      expiresAt: now + 30_000,
      expiryAgeMs: -30_000,
      refreshWindowMs: 60_000,
    });
    expect(JSON.stringify(logRefreshDiagnostic.mock.calls)).not.toContain('old-refresh');
  });

  it('preserves stored OAuth scope and token type when refresh omits them', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-scope-preserve-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-scope-preserve-'));
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: storedRecord } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
      }),
    } as unknown as ApiClient;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-scope-preserve',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });

    expect(result?.kind).toBe('oauth');
    expect(result?.oauth?.scope).toBe('user:inference user:profile user:sessions:claude_code');
    expect(result?.oauth?.tokenType).toBe('Bearer');
    expect(storedRecord.oauth?.scope).toBe('user:inference user:profile user:sessions:claude_code');
    expect(storedRecord.oauth?.tokenType).toBe('Bearer');
  });

  it('updates stored OAuth scope and token type when refresh returns replacements', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-scope-update-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-scope-update-'));
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: storedRecord } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
      }),
    } as unknown as ApiClient;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
        token_type: 'Bearer',
      }),
    })) as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-scope-update',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });

    expect(result?.kind).toBe('oauth');
    expect(result?.oauth?.scope).toBe('user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload');
    expect(result?.oauth?.tokenType).toBe('Bearer');
    expect(storedRecord.oauth?.scope).toBe('user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload');
    expect(storedRecord.oauth?.tokenType).toBe('Bearer');
  });
});
