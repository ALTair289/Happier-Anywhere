import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { Credentials } from '@/persistence';
import {
  storeConnectedServiceCredentialForAccount,
  type ConnectedServiceCredentialStorageApi,
} from './storeConnectedServiceCredentialForAccount';

const revision = 'csr_abcdefghijklmnopqrstuv';

function createRecord(): ConnectedServiceCredentialRecordV1 {
  return buildConnectedServiceCredentialRecord({
    now: 1_000,
    serviceId: 'anthropic',
    profileId: 'default',
    kind: 'token',
    token: { token: 'secret-token', providerAccountId: null, providerEmail: null },
  });
}

function createCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
  };
}

function createApi(overrides: Partial<ConnectedServiceCredentialStorageApi>): ConnectedServiceCredentialStorageApi {
  return {
    getAccountEncryptionMode: async () => 'e2ee',
    getConnectedServiceCredentialPlain: async () => null,
    getConnectedServiceCredentialSealed: async () => null,
    registerConnectedServiceCredentialPlain: async () => ({ success: true, credentialRevision: revision }),
    registerConnectedServiceCredentialSealed: async () => ({ success: true, credentialRevision: revision }),
    ...overrides,
  };
}

describe('storeConnectedServiceCredentialForAccount', () => {
  it('reuses one sealed ciphertext when an ambiguous write settles unchanged before retry', async () => {
    const getSealed = vi.fn(async () => null);
    const registerSealed = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after request'))
      .mockResolvedValueOnce({ success: true, credentialRevision: revision });
    const api = createApi({
      getConnectedServiceCredentialSealed: getSealed,
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
      randomBytes: (length) => new Uint8Array(length).fill(4),
    })).resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });

    expect(registerSealed).toHaveBeenCalledTimes(2);
    expect(registerSealed.mock.calls[0]?.[0]).toEqual(registerSealed.mock.calls[1]?.[0]);
    expect(registerSealed.mock.calls[0]?.[0]).toMatchObject({ expectedCredentialRevision: null });
    expect(getSealed).toHaveBeenCalledTimes(2);
  });

  it('adopts a committed ambiguous sealed write without posting again', async () => {
    let written: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']>[0] | null = null;
    const getSealed = vi.fn(async () => written === null ? null : ({
      revisionSemantics: 'revisioned' as const,
      credentialRevision: revision,
      sealed: written.sealed,
      metadata: written.metadata!,
    }));
    const registerSealed = vi.fn(async (params: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']>[0]) => {
      written = params;
      throw new Error('connection closed after commit');
    });
    const api = createApi({
      getConnectedServiceCredentialSealed: getSealed,
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
      randomBytes: (length) => new Uint8Array(length).fill(5),
    })).resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });

    expect(registerSealed).toHaveBeenCalledTimes(1);
  });

  it('does not retry a definite client rejection', async () => {
    const registerSealed = vi.fn(async () => {
      throw new HttpStatusError(400, 'invalid request');
    });
    const api = createApi({ registerConnectedServiceCredentialSealed: registerSealed });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).rejects.toMatchObject({ response: { status: 400 } });

    expect(registerSealed).toHaveBeenCalledTimes(1);
  });

  it('does not manufacture a credential revision for a legacy-unfenced write', async () => {
    const registerSealed = vi.fn<
      ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']
    >(async () => ({ success: true as const }));
    const api = createApi({
      getConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
        sealed: { format: 'account_scoped_v1', ciphertext: 'existing' },
        metadata: { kind: 'token' },
      }),
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).resolves.toEqual({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    });
    expect(registerSealed.mock.calls[0]?.[0]).not.toHaveProperty('expectedCredentialRevision');
  });

  it('does not post again when an ambiguous result cannot be settled by an authoritative read', async () => {
    const getSealed = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('settlement read unavailable'));
    const writeError = new Error('connection closed after request');
    const registerSealed = vi.fn(async () => {
      throw writeError;
    });
    const api = createApi({
      getConnectedServiceCredentialSealed: getSealed,
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).rejects.toBe(writeError);

    expect(registerSealed).toHaveBeenCalledTimes(1);
  });
});
