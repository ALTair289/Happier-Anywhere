import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { join } from 'node:path';

import { requireConnectedServiceOauthCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import { computeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export const GEMINI_ACP_AUTH_METHOD_ENV = 'HAPPIER_GEMINI_ACP_AUTH_METHOD';
export const GEMINI_ACP_AUTH_META_ENV = 'HAPPIER_GEMINI_ACP_AUTH_META';
export const GEMINI_CONNECTED_SERVICE_PROVIDER_ACCOUNT_ID_ENV =
  'HAPPIER_GEMINI_CONNECTED_SERVICE_PROVIDER_ACCOUNT_ID';
export const GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL_ENV =
  'HAPPIER_GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL';
export const GEMINI_CONNECTED_SERVICE_CREDENTIAL_FINGERPRINT_ENV =
  'HAPPIER_GEMINI_CONNECTED_SERVICE_CREDENTIAL_FINGERPRINT';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readCredentialRaw(record: ConnectedServiceCredentialRecordV1): Record<string, unknown> | null {
  return readRecord(record.kind === 'oauth' ? record.oauth.raw : record.token.raw);
}

function readNestedRecord(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const nested = readRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

function hasVertexMetadata(raw: Record<string, unknown> | null): boolean {
  const vertex = raw
    ? readNestedRecord(raw, ['vertexAi', 'vertexAI', 'vertex_ai', 'vertex'])
      ?? readNestedRecord(readNestedRecord(raw, ['gemini']) ?? {}, ['vertexAi', 'vertexAI', 'vertex_ai', 'vertex'])
    : null;
  return vertex !== null;
}

function hasGatewayAuthMetadata(raw: Record<string, unknown> | null): boolean {
  const meta = raw
    ? readNestedRecord(raw, ['gateway'])
      ?? readNestedRecord(readNestedRecord(raw, ['_meta']) ?? {}, ['gateway'])
      ?? readNestedRecord(readNestedRecord(raw, ['gemini']) ?? {}, ['gateway'])
    : null;
  return meta !== null;
}

type UnsupportedGeminiConnectedServiceCredentialShape = 'token' | 'vertex' | 'gateway';

class UnsupportedGeminiConnectedServiceCredentialError extends Error {
  readonly code = 'gemini_connected_service_credential_shape_unsupported';

  constructor(readonly credentialShape: UnsupportedGeminiConnectedServiceCredentialShape) {
    super(`Remote Gemini connected services do not support ${credentialShape} credentials`);
    this.name = 'UnsupportedGeminiConnectedServiceCredentialError';
  }
}

export async function materializeGeminiConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  record: ConnectedServiceCredentialRecordV1;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
  const raw = readCredentialRaw(params.record);

  if (hasGatewayAuthMetadata(raw)) {
    throw new UnsupportedGeminiConnectedServiceCredentialError('gateway');
  }
  if (hasVertexMetadata(raw)) {
    throw new UnsupportedGeminiConnectedServiceCredentialError('vertex');
  }
  if (params.record.kind === 'token') {
    throw new UnsupportedGeminiConnectedServiceCredentialError('token');
  }

  // Gemini CLI uses oauth-personal when it can find local OAuth credentials at ~/.gemini/oauth_creds.json.
  // We materialize an isolated HOME so the spawned Gemini process can authenticate without requiring
  // user-interactive `gemini auth` on the remote machine.
  const homeDir = join(params.rootDir, 'home');
  const oauthCredsPath = join(homeDir, '.gemini', 'oauth_creds.json');

  const record = requireConnectedServiceOauthCredentialRecord(params.record);
  await writeJsonAtomic(oauthCredsPath, {
    access_token: record.oauth.accessToken,
    token_type: record.oauth.tokenType ?? 'Bearer',
    scope: record.oauth.scope ?? 'https://www.googleapis.com/auth/cloud-platform',
    ...(record.oauth.refreshToken ? { refresh_token: record.oauth.refreshToken } : {}),
    ...(record.oauth.idToken ? { id_token: record.oauth.idToken } : {}),
    ...(typeof record.expiresAt === 'number' ? { expires_at: record.expiresAt } : {}),
  });

  const env: Record<string, string> = {
    HOME: homeDir,
    GEMINI_CLI_HOME: homeDir,
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
    GEMINI_FORCE_FILE_STORAGE: 'true',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    ...(record.oauth.providerAccountId
      ? { [GEMINI_CONNECTED_SERVICE_PROVIDER_ACCOUNT_ID_ENV]: record.oauth.providerAccountId }
      : {}),
    ...(record.oauth.providerEmail
      ? { [GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL_ENV]: record.oauth.providerEmail }
      : {}),
    [GEMINI_CONNECTED_SERVICE_CREDENTIAL_FINGERPRINT_ENV]:
      computeConnectedServiceAccessTokenFingerprint(record.oauth.accessToken),
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = homeDir;
  }
  return {
    env,
  };
}
