import {
  ConnectedServiceCredentialRecordV1Schema,
  openConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

export function openConnectedServiceRecord(params: Readonly<{
  credentials: Credentials;
  ciphertext: string;
}>): ConnectedServiceCredentialRecordV1 {
  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: params.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new Error('Failed to decrypt connected service credential');
  }
  return ConnectedServiceCredentialRecordV1Schema.parse(opened.value);
}

export function buildUpdatedOauthRecord(params: Readonly<{
  now: number;
  record: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' };
  next: Readonly<{
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    scope?: string | null;
    tokenType?: string | null;
    providerAccountId?: string | null;
    providerEmail?: string | null;
    expiresAt: number | null;
  }>;
}>): ConnectedServiceCredentialRecordV1 {
  return ConnectedServiceCredentialRecordV1Schema.parse({
    ...params.record,
    updatedAt: params.now,
    expiresAt: params.next.expiresAt,
    oauth: {
      ...params.record.oauth,
      accessToken: params.next.accessToken,
      refreshToken: params.next.refreshToken,
      idToken: params.next.idToken,
      scope: params.next.scope ?? params.record.oauth.scope,
      tokenType: params.next.tokenType ?? params.record.oauth.tokenType,
      providerAccountId: params.next.providerAccountId ?? params.record.oauth.providerAccountId,
      providerEmail: params.next.providerEmail ?? params.record.oauth.providerEmail,
    },
  });
}

export function hasObservedOauthCredentialChanged(
  before: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' },
  after: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' },
): boolean {
  return before.updatedAt !== after.updatedAt
    || before.expiresAt !== after.expiresAt
    || before.oauth.accessToken !== after.oauth.accessToken
    || before.oauth.refreshToken !== after.oauth.refreshToken
    || before.oauth.idToken !== after.oauth.idToken
    || before.oauth.scope !== after.oauth.scope
    || before.oauth.tokenType !== after.oauth.tokenType;
}
