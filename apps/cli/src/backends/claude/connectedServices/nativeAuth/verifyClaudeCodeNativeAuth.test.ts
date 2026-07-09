import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  verifyClaudeCodeNativeAuth,
} from './verifyClaudeCodeNativeAuth';
import {
  computeClaudeCodeCredentialFingerprint,
  resolveClaudeCodeCredentialsFilePath,
  writeClaudeCodeCredentialsFile,
} from './claudeCodeCredentialFile';
import {
  resolveClaudeConnectedServiceHomeProvenancePath,
} from '../claudeConnectedServiceHomeProvenance';

const NOW_MS = Date.parse('2026-06-06T12:00:00.000Z');
const FUTURE_EXPIRES_AT_MS = NOW_MS + 60 * 60 * 1000;
const PAST_EXPIRES_AT_MS = NOW_MS - 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

describe('verifyClaudeCodeNativeAuth', () => {
  beforeEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('verifies an isolated Claude config dir with native Claude Code credentials', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS })).toEqual({
      status: 'ok',
      missingScopes: [],
      credentialPath: join(claudeConfigDir, '.credentials.json'),
    });
  });

  it('rejects an already-expired credential as a usability gate', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-secret-placeholder',
          refreshToken: 'refresh-secret-placeholder',
          expiresAt: PAST_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS });

    expect(result.status).toBe('expired');
    expect(result.missingScopes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret-placeholder');
  });

  it('does not reject a credential whose expiry is unknown (null)', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    await writeFile(
      credentialPath,
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      })}\n`,
    );

    expect(await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS })).toEqual({
      status: 'ok',
      missingScopes: [],
      credentialPath,
    });
  });

  it('fails closed when the credentials file is missing', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    expect((await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS })).status).toBe(
      'missing_credentials_file',
    );
  });

  it('fails closed when the credential shape is unsupported', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    await writeFile(credentialPath, `${JSON.stringify({ unexpected: true })}\n`);

    expect((await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS })).status).toBe(
      'unsupported_shape',
    );
  });

  it('fails closed without exposing credential values when the file is missing required scope', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-secret-placeholder',
          refreshToken: 'refresh-secret-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile'],
        },
      },
    });

    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS });

    expect(result).toEqual({
      status: 'missing_required_scope',
      missingScopes: ['user:sessions:claude_code'],
      credentialPath: join(claudeConfigDir, '.credentials.json'),
    });
    expect(JSON.stringify(result)).not.toContain('secret-placeholder');
    expect(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')).toContain('secret-placeholder');
  });

  it('accepts access-token-only credentials on darwin when a matching keychain entry has no refresh token', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    vi.doMock('./claudeCodeMacOsKeychain', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./claudeCodeMacOsKeychain')>();
      return {
        ...actual,
        readClaudeCodeMacOsKeychainCredential: vi.fn(async () => ({
          claudeAiOauth: {
            accessToken: 'access-placeholder',
            expiresAt: FUTURE_EXPIRES_AT_MS,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
          },
        })),
      };
    });

    const { verifyClaudeCodeNativeAuth: verifyUnderDarwin } = await import('./verifyClaudeCodeNativeAuth');
    const result = await verifyUnderDarwin({ claudeConfigDir, now: NOW_MS });

    expect(result).toEqual({
      status: 'ok',
      missingScopes: [],
      credentialPath: join(claudeConfigDir, '.credentials.json'),
    });
  });

  it('fails closed when materialized credentials do not match the connected-service provenance fingerprint', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-secret-placeholder',
          refreshToken: 'refresh-secret-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });
    await writeFile(
      resolveClaudeConnectedServiceHomeProvenancePath(claudeConfigDir),
      `${JSON.stringify({
        v: 1,
        serviceId: 'claude-subscription',
        credentialProfileId: 'profile-a',
        credentialCreatedAt: 1000,
        credentialFingerprint: 'sha256:mismatch',
        selection: { kind: 'profile', profileId: 'profile-a' },
      })}\n`,
    );

    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS });

    expect(result.status).toBe('credential_fingerprint_mismatch');
    expect(JSON.stringify(result)).not.toContain('secret-placeholder');
  });

  it('fails closed on darwin when the keychain credential fingerprint differs from the credential file', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    const filePayload = {
      claudeAiOauth: {
        accessToken: 'access-secret-placeholder',
        refreshToken: 'refresh-secret-placeholder',
        expiresAt: FUTURE_EXPIRES_AT_MS,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    };
    const keychainPayload = {
      claudeAiOauth: {
        accessToken: 'different-access-secret-placeholder',
        refreshToken: 'different-refresh-secret-placeholder',
        expiresAt: FUTURE_EXPIRES_AT_MS,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    };
    await writeClaudeCodeCredentialsFile({ claudeConfigDir, payload: filePayload });
    const materializedPayload = JSON.parse(await readFile(resolveClaudeCodeCredentialsFilePath(claudeConfigDir), 'utf8'));
    await writeFile(
      resolveClaudeConnectedServiceHomeProvenancePath(claudeConfigDir),
      `${JSON.stringify({
        v: 1,
        serviceId: 'claude-subscription',
        credentialProfileId: 'profile-a',
        credentialCreatedAt: 1000,
        credentialFingerprint: computeClaudeCodeCredentialFingerprint(materializedPayload),
        selection: { kind: 'profile', profileId: 'profile-a' },
      })}\n`,
    );
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    vi.doMock('./claudeCodeMacOsKeychain', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./claudeCodeMacOsKeychain')>();
      return {
        ...actual,
        readClaudeCodeMacOsKeychainCredential: vi.fn(async () => keychainPayload),
      };
    });

    const { verifyClaudeCodeNativeAuth: verifyUnderDarwin } = await import('./verifyClaudeCodeNativeAuth');
    const result = await verifyUnderDarwin({ claudeConfigDir, now: NOW_MS });

    expect(result.status).toBe('credential_fingerprint_mismatch');
    expect(JSON.stringify(result)).not.toContain('secret-placeholder');
  });
});
