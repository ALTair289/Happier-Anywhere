import {
  ConnectedServiceCredentialRecordV1Schema,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { resolveConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import {
  openConnectedServiceRecord,
} from './oauthCredentialRecords';
import type {
  BoundProfile,
  ConnectedServiceCredentialSource,
} from './refreshTypes';

export async function readCredentialForRefresh(input: Readonly<{
  api: ApiClient;
  credentials: Credentials;
  binding: BoundProfile;
}>): Promise<ConnectedServiceCredentialSource | null> {
  const accountMode = await resolveConnectedServiceAccountMode(input.api);
  if (accountMode !== 'e2ee' && typeof input.api.getConnectedServiceCredentialPlain === 'function') {
    const plain = accountMode === 'unknown'
      ? await input.api.getConnectedServiceCredentialPlain({
          serviceId: input.binding.serviceId,
          profileId: input.binding.profileId,
        }).catch(() => null)
      : await input.api.getConnectedServiceCredentialPlain({
          serviceId: input.binding.serviceId,
          profileId: input.binding.profileId,
        });
    if (plain) {
      return { mode: 'plain', record: ConnectedServiceCredentialRecordV1Schema.parse(plain.content.v) };
    }
    if (accountMode === 'plain') return null;
  }

  const sealed = await input.api.getConnectedServiceCredentialSealed({
    serviceId: input.binding.serviceId,
    profileId: input.binding.profileId,
  });
  if (!sealed) return null;
  const record = openConnectedServiceRecord({
    credentials: input.credentials,
    ciphertext: sealed.sealed.ciphertext,
  });
  return { mode: 'sealed', record, metadata: sealed.metadata };
}

export async function persistRefreshedCredential(input: Readonly<{
  api: ApiClient;
  credentials: Credentials;
  binding: BoundProfile;
  source: ConnectedServiceCredentialSource;
  updated: ConnectedServiceCredentialRecordV1;
}>): Promise<void> {
  if (input.source.mode === 'plain') {
    await input.api.registerConnectedServiceCredentialPlain({
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      content: { t: 'plain', v: input.updated },
    });
    return;
  }

  const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
    material:
      input.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: input.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: input.credentials.encryption.machineKey },
    payload: input.updated,
    randomBytes: (length) => randomBytes(length),
  });

  await input.api.registerConnectedServiceCredentialSealed({
    serviceId: input.binding.serviceId,
    profileId: input.binding.profileId,
    sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
    metadata: {
      kind: input.updated.kind,
      providerEmail: input.updated.kind === 'oauth' ? input.updated.oauth.providerEmail : null,
      providerAccountId: input.updated.kind === 'oauth' ? input.updated.oauth.providerAccountId : null,
      expiresAt: input.updated.expiresAt,
    },
  });
}
