import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceCredentialRecordV1Schema,
  buildConnectedServiceCredentialRecord,
} from '@happier-dev/protocol';
import { computeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';

import { materializeGeminiConnectedServiceAuth } from './materializeGeminiConnectedServiceAuth';

describe('materializeGeminiConnectedServiceAuth', () => {
  it('writes OAuth credentials under the isolated connected-service home', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-gemini-auth-'));
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'gemini-p1',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'gemini-access',
        refreshToken: 'gemini-refresh',
        idToken: 'gemini-id-token',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        tokenType: 'Bearer',
        providerAccountId: 'google-account',
        providerEmail: 'user@example.com',
      },
    });

    const result = await materializeGeminiConnectedServiceAuth({ rootDir, record });

    const homeDir = join(rootDir, 'home');
    expect(result.env).toMatchObject({
      HOME: homeDir,
      GEMINI_CLI_HOME: homeDir,
      GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      GEMINI_FORCE_FILE_STORAGE: 'true',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      HAPPIER_GEMINI_CONNECTED_SERVICE_PROVIDER_ACCOUNT_ID: 'google-account',
      HAPPIER_GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL: 'user@example.com',
      HAPPIER_GEMINI_CONNECTED_SERVICE_CREDENTIAL_FINGERPRINT:
        computeConnectedServiceAccessTokenFingerprint('gemini-access'),
      ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
    });
    const raw = await readFile(join(homeDir, '.gemini', 'oauth_creds.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({
      access_token: 'gemini-access',
      refresh_token: 'gemini-refresh',
      id_token: 'gemini-id-token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      token_type: 'Bearer',
      expires_at: now + 60_000,
    });
  });

  it('fails closed for Vertex metadata because Remote Gemini supports OAuth Code Assist only', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-gemini-auth-'));
    const record = ConnectedServiceCredentialRecordV1Schema.parse({
      ...buildConnectedServiceCredentialRecord({
        now: 1_700_000_000_000,
        serviceId: 'gemini',
        profileId: 'vertex-profile',
        kind: 'oauth',
        expiresAt: 1_700_000_060_000,
        oauth: {
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          idToken: null,
          scope: 'https://www.googleapis.com/auth/cloud-platform',
          tokenType: 'Bearer',
          providerAccountId: 'google-account',
          providerEmail: 'user@example.com',
        },
      }),
      oauth: {
        accessToken: 'oauth-access-token',
        refreshToken: 'oauth-refresh-token',
        idToken: null,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        tokenType: 'Bearer',
        providerAccountId: 'google-account',
        providerEmail: 'user@example.com',
        raw: {
          vertexAi: {
            project: 'vertex-project',
            location: 'us-central1',
          },
        },
      },
    });

    await expect(materializeGeminiConnectedServiceAuth({ rootDir, record })).rejects.toMatchObject({
      code: 'gemini_connected_service_credential_shape_unsupported',
      credentialShape: 'vertex',
    });
  });

  it('fails closed for token and gateway credentials because Remote Gemini supports OAuth Code Assist only', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-gemini-auth-'));
    const record = ConnectedServiceCredentialRecordV1Schema.parse({
      ...buildConnectedServiceCredentialRecord({
        now: 1_700_000_000_000,
        serviceId: 'gemini',
        profileId: 'gateway-profile',
        kind: 'token',
        token: {
          token: 'gateway-token',
          providerAccountId: null,
          providerEmail: null,
        },
      }),
      token: {
        token: 'gateway-token',
        providerAccountId: null,
        providerEmail: null,
        raw: {
          gateway: {
            baseUrl: 'https://gateway.example.test/v1',
            headers: {
              Authorization: 'Bearer gateway-token',
              'X-Gateway-Account': 'acct-1',
            },
          },
        },
      },
    });

    await expect(materializeGeminiConnectedServiceAuth({ rootDir, record })).rejects.toMatchObject({
      code: 'gemini_connected_service_credential_shape_unsupported',
      credentialShape: 'gateway',
    });
  });

  it('fails closed for a raw token credential without gateway metadata', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-gemini-auth-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'gemini',
      profileId: 'token-profile',
      kind: 'token',
      token: {
        token: 'gemini-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(materializeGeminiConnectedServiceAuth({ rootDir, record })).rejects.toMatchObject({
      code: 'gemini_connected_service_credential_shape_unsupported',
      credentialShape: 'token',
    });
  });
});
