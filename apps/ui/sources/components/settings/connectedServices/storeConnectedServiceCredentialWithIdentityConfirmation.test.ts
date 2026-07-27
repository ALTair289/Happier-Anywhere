import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

const confirmMock = vi.fn();
const storeMock = vi.fn();
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

vi.mock('@/modal', () => ({
  Modal: {
    confirm: confirmMock,
  },
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: storeMock,
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

const credentials: AuthCredentials = {
  token: 'token',
  secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

function sampleRecord(): ConnectedServiceCredentialRecordV1 {
  const now = Date.now();
  return {
    v: 1,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'token',
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    oauth: null,
    token: { token: 'tok', providerAccountId: null, providerEmail: null, raw: null },
  };
}

describe('storeConnectedServiceCredentialWithIdentityConfirmation', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    storeMock.mockReset();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
  });

  it('returns false without replacing credentials when identity mismatch confirmation is cancelled', async () => {
    storeMock.mockRejectedValueOnce(new Error('connect_reconnect_provider_identity_mismatch'));
    confirmMock.mockResolvedValueOnce(false);
    const onStored = vi.fn();

    const { storeConnectedServiceCredentialWithIdentityConfirmation } = await import(
      './storeConnectedServiceCredentialWithIdentityConfirmation'
    );
    const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(
      credentials,
      {
        serviceId: 'openai-codex',
        profileId: 'work',
        record: sampleRecord(),
      },
      { onStored },
    );

    expect(stored).toBe(false);
    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(onStored).not.toHaveBeenCalled();
  });

  it('returns true after retrying with identity replacement when the follow-up effects fail', async () => {
    const mismatch = Object.assign(new Error('connect_reconnect_provider_identity_mismatch'), {
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });
    storeMock.mockRejectedValueOnce(mismatch);
    storeMock.mockResolvedValueOnce(undefined);
    confirmMock.mockResolvedValueOnce(true);
    const onStored = vi.fn(async () => {
      throw new Error('post-store refresh failed');
    });

    const { storeConnectedServiceCredentialWithIdentityConfirmation } = await import(
      './storeConnectedServiceCredentialWithIdentityConfirmation'
    );
    const params = {
      serviceId: 'openai-codex' as const,
      profileId: 'work',
      record: sampleRecord(),
    };
    const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(credentials, params, { onStored });

    expect(stored).toBe(true);
    expect(storeMock).toHaveBeenNthCalledWith(2, credentials, params, {
      allowProviderIdentityChange: true,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });
    expect(onStored).toHaveBeenCalledWith(params);
  });

  it('preserves the expect-absent guard across identity confirmation', async () => {
    const mismatch = Object.assign(new Error('connect_reconnect_provider_identity_mismatch'), {
      expectedCredentialRevision: null,
    });
    storeMock.mockRejectedValueOnce(mismatch);
    storeMock.mockRejectedValueOnce(Object.assign(new Error('connect_credential_mutation_superseded'), {
      code: 'connect_credential_mutation_superseded',
      credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
    }));
    confirmMock.mockResolvedValueOnce(true);

    const { storeConnectedServiceCredentialWithIdentityConfirmation } = await import(
      './storeConnectedServiceCredentialWithIdentityConfirmation'
    );
    const params = {
      serviceId: 'openai-codex' as const,
      profileId: 'work',
      record: sampleRecord(),
    };

    await expect(storeConnectedServiceCredentialWithIdentityConfirmation(credentials, params)).rejects.toMatchObject({
      code: 'connect_credential_mutation_superseded',
    });
    expect(storeMock).toHaveBeenNthCalledWith(2, credentials, params, {
      allowProviderIdentityChange: true,
      expectedCredentialRevision: null,
    });
  });

  it('returns true when follow-up effects fail after credentials are stored', async () => {
    const onStored = vi.fn(async () => {
      throw new Error('post-store refresh failed');
    });

    const { storeConnectedServiceCredentialWithIdentityConfirmation } = await import(
      './storeConnectedServiceCredentialWithIdentityConfirmation'
    );
    const params = {
      serviceId: 'openai-codex' as const,
      profileId: 'work',
      record: sampleRecord(),
    };
    const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(credentials, params, { onStored });

    expect(stored).toBe(true);
    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(onStored).toHaveBeenCalledWith(params);
    expect(storeMock.mock.invocationCallOrder[0]).toBeLessThan(onStored.mock.invocationCallOrder[0]);
  });
});
