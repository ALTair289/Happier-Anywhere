import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  buildClaudeCodeCredentialPayload,
  computeClaudeCodeCredentialAccountProofFingerprint,
  computeClaudeCodeCredentialFingerprint,
  parseClaudeCodeCredentialFile,
  resolveClaudeCodeCredentialsFilePath,
  writeClaudeCodeCredentialsFile,
} from './claudeCodeCredentialFile';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './claudeCodeCredentialScopes';

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;

describe('claudeCodeCredentialFile', () => {
  it('builds the native Claude Code credential payload from an OAuth record', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(buildClaudeCodeCredentialPayload(record)).toEqual({
      status: 'ok',
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: [
            'user:inference',
            'user:profile',
            'user:sessions:claude_code',
            'user:mcp_servers',
            'user:file_upload',
          ],
        },
      },
    });
  });

  it('omits expiresAt rather than coercing a null record expiry to an immediately-expired 0', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const built = buildClaudeCodeCredentialPayload(record);
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') throw new Error('expected ok payload');
    expect(built.payload.claudeAiOauth.expiresAt).toBeUndefined();
    expect(built.payload.claudeAiOauth.accessToken).toBe('access-placeholder');
  });

  it('includes optional Claude subscription metadata when raw native OAuth data is available', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
        raw: {
          claudeAiOauth: {
            subscriptionType: 'max',
            rateLimitTier: 'max_20x',
          },
        },
      },
    });

    expect(buildClaudeCodeCredentialPayload(record)).toEqual({
      status: 'ok',
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: [
            'user:inference',
            'user:profile',
            'user:sessions:claude_code',
            'user:mcp_servers',
            'user:file_upload',
          ],
          subscriptionType: 'max',
          rateLimitTier: 'max_20x',
        },
      },
    });
  });

  it('computes account proof fingerprints without volatile credential expiry', () => {
    const firstPayload = {
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        expiresAt: REALISTIC_EXPIRES_AT_MS,
        scopes: ['user:profile', 'user:inference'],
      },
    };
    const refreshedExpiryPayload = {
      claudeAiOauth: {
        ...firstPayload.claudeAiOauth,
        expiresAt: REALISTIC_EXPIRES_AT_MS + 1_000,
      },
    };

    expect(computeClaudeCodeCredentialFingerprint(firstPayload)).not.toBe(
      computeClaudeCodeCredentialFingerprint(refreshedExpiryPayload),
    );
    expect(computeClaudeCodeCredentialAccountProofFingerprint(firstPayload)).toBe(
      computeClaudeCodeCredentialAccountProofFingerprint(refreshedExpiryPayload),
    );
  });

  it('writes .credentials.json atomically under the selected CLAUDE_CONFIG_DIR', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(credentialPath).toBe(join(claudeConfigDir, '.credentials.json'));
    const parsed = JSON.parse(await readFile(credentialPath, 'utf8'));
    expect(parsed.claudeAiOauth.accessToken).toBe('access-placeholder');
    expect(parsed.claudeAiOauth.refreshToken).toBe('refresh-placeholder');
    expect(parsed.claudeAiOauth.expiresAt).toBe(REALISTIC_EXPIRES_AT_MS);
    expect(parsed.claudeAiOauth.expiresAt).toBeGreaterThan(1_000_000_000_000);

    if (process.platform !== 'win32') {
      const mode = (await stat(credentialPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('parses credential health without exposing credential values', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-secret-placeholder',
          refreshToken: 'refresh-secret-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });
    await chmod(credentialPath, 0o600);

    const safe = parseClaudeCodeCredentialFile(JSON.parse(await readFile(credentialPath, 'utf8')));

    expect(safe).toEqual({
      status: 'ok',
      hasAccessToken: true,
      hasRefreshToken: true,
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    });
    expect(JSON.stringify(safe)).not.toContain('secret-placeholder');
  });
});
