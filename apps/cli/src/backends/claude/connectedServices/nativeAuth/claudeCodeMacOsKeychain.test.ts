import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { logger } from '@/ui/logger';

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnSpy,
  };
});

import {
  computeClaudeCodeCredentialFingerprint,
  type ClaudeCodeNativeCredentialPayload,
} from './claudeCodeNativeCredentialPayload';
import {
  deleteClaudeCodeMacOsKeychainCredential,
  readClaudeCodeMacOsKeychainCredential,
  resolveClaudeCodeMacOsKeychainServiceName,
  sweepStaleClaudeCodeMacOsKeychainCredentials,
  writeClaudeCodeMacOsKeychainCredential,
} from './claudeCodeMacOsKeychain';

describe('claudeCodeMacOsKeychain', () => {
  const securityInputs: string[] = [];

  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawnSpy.mockReset();
    securityInputs.length = 0;
  });

  function keychainMetadata(updatedAt = '20260605120100Z') {
    return [
      'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
      'version: 512',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="tester"',
      `    "mdat"<timedate>=0x32303236303630353132303130305A00  "${updatedAt}\\000"`,
    ].join('\n');
  }

  function successfulSpawnResult() {
    return {
      status: 0,
      stdout: '',
      stderr: '',
    };
  }

  function mockSecurityProcess(result: Readonly<{ status: number | null; stdout?: string; stderr?: string }>) {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        securityInputs.push(String(_chunk));
        callback();
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', result.status);
    });
    return child;
  }

  function mockSecuritySpawn(
    resolve: (args: readonly string[]) => Readonly<{ status: number | null; stdout?: string; stderr?: string }>,
  ): void {
    spawnSpy.mockImplementation((_command: string, args: readonly string[]) => mockSecurityProcess(resolve(args)));
  }

  function mockMissingKeychainWithSuccessfulWrites(): void {
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password') return { status: 44, stderr: 'not found' };
      return successfulSpawnResult();
    });
  }

  function dumpKeychainItems(items: readonly Readonly<{ account: string; service: string }>[]): string {
    return items.map((item) => [
      'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
      'version: 512',
      'class: "genp"',
      'attributes:',
      `    "acct"<blob>="${item.account}"`,
      `    "svce"<blob>="${item.service}"`,
    ].join('\n')).join('\n\n');
  }

  it('uses the unsuffixed service for the default Claude config dir and a hashed suffix for custom dirs', () => {
    expect(
      resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: '/Users/tester/.claude',
        homeDir: '/Users/tester',
      }),
    ).toBe('Claude Code-credentials');

    expect(
      resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: '/tmp/custom-claude-home',
        homeDir: '/Users/tester',
      }),
    ).toBe('Claude Code-credentials-e161167c');
  });

  it('writes the credential JSON to the derived macOS keychain service without putting secrets in argv', async () => {
    mockMissingKeychainWithSuccessfulWrites();

    await writeClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: 123,
          scopes: ['user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      'security',
      [
        'add-generic-password',
        '-U',
        '-a',
        'tester',
        '-s',
        'Claude Code-credentials-e161167c',
        '-w',
      ],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(securityInputs.join('')).toContain('access-placeholder');
    expect(securityInputs.join('')).not.toContain('refresh-placeholder');
    expect(spawnSpy.mock.calls[0]?.[1]).not.toContain('access-placeholder');
    expect(spawnSpy.mock.calls[0]?.[1]).not.toContain('refresh-placeholder');
    expect(spawnSpy.mock.calls.some((call) => (call[1] as readonly string[])[0] === 'delete-generic-password')).toBe(false);
  });

  it('skips an unreadable existing credential when the incoming fingerprint matches our last successful write', async () => {
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password') {
        return { status: 44, stderr: 'User interaction is not allowed.' };
      }
      return successfulSpawnResult();
    });
    const payload: ClaudeCodeNativeCredentialPayload = {
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        expiresAt: 123,
        scopes: ['user:profile', 'user:sessions:claude_code'],
      },
    };
    const writeWithProvenance = writeClaudeCodeMacOsKeychainCredential as (
      params: Parameters<typeof writeClaudeCodeMacOsKeychainCredential>[0] & Readonly<{
        lastWrittenProvenance: Readonly<{
          credentialFingerprint: string;
          writtenAtMs: number;
        }>;
      }>,
    ) => ReturnType<typeof writeClaudeCodeMacOsKeychainCredential>;

    const result = await writeWithProvenance({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
      payload,
      lastWrittenProvenance: {
        credentialFingerprint: computeClaudeCodeCredentialFingerprint(payload),
        writtenAtMs: Date.parse('2026-06-05T12:02:00.000Z'),
      },
      diagnosticContext: { profileId: 'work', homeKind: 'group' },
    });

    expect(result).toEqual(expect.objectContaining({ status: 'skipped_provenance_match' }));
    expect(spawnSpy.mock.calls.some((call) => (call[1] as readonly string[])[0] === 'add-generic-password')).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      '[DAEMON RUN] Claude Code keychain credential decision',
      expect.objectContaining({
        decision: 'skip_provenance_match',
        comparatorBasis: expect.objectContaining({ existing: null }),
        provenanceBasis: expect.objectContaining({
          incomingMatchesLastWritten: true,
          newerExternalChangeDetected: false,
        }),
      }),
    );
  });

  it('bounds macOS security writes and deletes so a locked keychain cannot block the daemon forever', async () => {
    mockMissingKeychainWithSuccessfulWrites();

    await writeClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          expiresAt: 123,
          scopes: ['user:profile', 'user:sessions:claude_code'],
        },
      },
    });
    await deleteClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
    });

    expect(spawnSpy).toHaveBeenCalledWith('security', expect.any(Array), expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(spawnSpy).not.toHaveBeenCalledWith('security', expect.any(Array), expect.objectContaining({ timeout: expect.any(Number) }));
  });

  it('does not overwrite a fresher valid keychain credential with a staler daemon credential', async () => {
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password' && args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'fresh-login-access-secret',
            refreshToken: 'fresh-login-refresh-secret',
            expiresAt: 456,
            scopes: ['user:profile', 'user:sessions:claude_code'],
          },
        }) };
      }
      if (args[0] === 'find-generic-password') return { status: 0, stdout: keychainMetadata() };
      return successfulSpawnResult();
    });

    const result = await writeClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
      incomingUpdatedAtMs: Date.parse('2026-06-05T12:00:00.000Z'),
      payload: {
        claudeAiOauth: {
          accessToken: 'stale-daemon-access-secret',
          refreshToken: 'stale-daemon-refresh-secret',
          expiresAt: 123,
          scopes: ['user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'skipped_existing_newer',
      adoptedCredential: expect.objectContaining({
        payload: expect.objectContaining({
          claudeAiOauth: expect.objectContaining({
            accessToken: 'fresh-login-access-secret',
            refreshToken: 'fresh-login-refresh-secret',
          }),
        }),
      }),
    }));
    expect(spawnSpy.mock.calls.some((call) => (call[1] as readonly string[]).includes('add-generic-password'))).toBe(false);
  });

  it('overwrites a fresher keychain credential when the caller is switching to a different account', async () => {
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password' && args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'previous-account-access-secret',
            refreshToken: 'previous-account-refresh-secret',
            expiresAt: 456,
            scopes: ['user:profile', 'user:sessions:claude_code'],
          },
        }) };
      }
      if (args[0] === 'find-generic-password') return { status: 0, stdout: keychainMetadata() };
      return successfulSpawnResult();
    });

    const writeWithFreshnessOptions = writeClaudeCodeMacOsKeychainCredential as (
      params: Parameters<typeof writeClaudeCodeMacOsKeychainCredential>[0] & Readonly<{
        preserveNewerExistingCredential: boolean;
      }>,
    ) => ReturnType<typeof writeClaudeCodeMacOsKeychainCredential>;

    const result = await writeWithFreshnessOptions({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
      preserveNewerExistingCredential: false,
      incomingUpdatedAtMs: Date.parse('2026-06-05T12:00:00.000Z'),
      payload: {
        claudeAiOauth: {
          accessToken: 'new-account-access-secret',
          refreshToken: 'new-account-refresh-secret',
          expiresAt: 123,
          scopes: ['user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: 'written' }));
    expect(spawnSpy.mock.calls.filter((call) => (call[1] as readonly string[]).includes('add-generic-password'))).toHaveLength(1);
    expect(securityInputs.join('')).toContain('new-account-access-secret');
    expect(securityInputs.join('')).not.toContain('new-account-refresh-secret');
  });

  it('overwrites a blank or invalid existing keychain credential', async () => {
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password' && args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: '',
            refreshToken: '',
            expiresAt: 456,
            scopes: [],
          },
        }) };
      }
      if (args[0] === 'find-generic-password') return { status: 0, stdout: keychainMetadata() };
      return successfulSpawnResult();
    });

    const result = await writeClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
      incomingUpdatedAtMs: Date.parse('2026-06-05T12:00:00.000Z'),
      payload: {
        claudeAiOauth: {
          accessToken: 'valid-access-secret',
          refreshToken: 'valid-refresh-secret',
          expiresAt: 123,
          scopes: ['user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: 'written' }));
    expect(spawnSpy.mock.calls.filter((call) => (call[1] as readonly string[]).includes('add-generic-password'))).toHaveLength(1);
  });

  it('emits safe machine-greppable diagnostics for keychain write and freshness-skip decisions', async () => {
    const info = vi.mocked(logger.info);
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password' && args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'fresh-login-access-secret',
            refreshToken: 'fresh-login-refresh-secret',
            expiresAt: 456,
            scopes: ['user:profile', 'user:sessions:claude_code'],
          },
        }) };
      }
      if (args[0] === 'find-generic-password') return { status: 0, stdout: keychainMetadata() };
      return successfulSpawnResult();
    });

    await writeClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
      incomingUpdatedAtMs: Date.parse('2026-06-05T12:00:00.000Z'),
      diagnosticContext: {
        profileId: 'work',
        homeKind: 'group',
      },
      payload: {
        claudeAiOauth: {
          accessToken: 'stale-daemon-access-secret',
          refreshToken: 'stale-daemon-refresh-secret',
          expiresAt: 123,
          scopes: ['user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(info).toHaveBeenCalledWith(
      '[DAEMON RUN] Claude Code keychain credential decision',
      expect.objectContaining({
        event: 'claude_code_keychain_credential_decision',
        profileId: 'work',
        homeKind: 'group',
        decision: 'skip_existing_newer',
        comparatorBasis: expect.objectContaining({
          existing: expect.objectContaining({
            source: 'macos_keychain',
            accessTokenFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{8}$/),
            refreshTokenFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{8}$/),
          }),
          incoming: expect.objectContaining({
            source: 'incoming',
            accessTokenFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{8}$/),
            refreshTokenFingerprint: null,
          }),
        }),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret');
  });

  it('reads and parses the derived macOS keychain credential payload', async () => {
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password' && args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'access-placeholder',
            refreshToken: 'refresh-placeholder',
            expiresAt: 123,
            scopes: ['user:profile', 'user:sessions:claude_code'],
          },
        }) };
      }
      if (args[0] === 'find-generic-password') return { status: 0, stdout: keychainMetadata() };
      return successfulSpawnResult();
    });

    await expect(
      readClaudeCodeMacOsKeychainCredential({
        claudeConfigDir: '/tmp/custom-claude-home',
        homeDir: '/Users/tester',
      }),
    ).resolves.toEqual({
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        expiresAt: 123,
        scopes: ['user:profile', 'user:sessions:claude_code'],
      },
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-a', 'leeroy', '-s', 'Claude Code-credentials-e161167c', '-w'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(spawnSpy).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-a', 'leeroy', '-s', 'Claude Code-credentials-e161167c'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('deletes the derived macOS keychain credential by account and service', async () => {
    mockSecuritySpawn(() => successfulSpawnResult());

    await expect(deleteClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
    })).resolves.toBeUndefined();

    expect(spawnSpy).toHaveBeenCalledWith(
      'security',
      ['delete-generic-password', '-a', 'tester', '-s', 'Claude Code-credentials-e161167c'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('treats missing derived macOS keychain credentials as already deleted', async () => {
    mockSecuritySpawn(() => ({
      status: 44,
      stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
    }));

    await expect(deleteClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
    })).resolves.toBeUndefined();
  });

  it('sweeps only stale derived Happier-owned macOS keychain services and is idempotent', async () => {
    const liveService = resolveClaudeCodeMacOsKeychainServiceName({
      claudeConfigDir: '/tmp/live-claude-home',
      homeDir: '/Users/tester',
    });
    const staleService = 'Claude Code-credentials-1111aaaa';
    const otherAccountService = 'Claude Code-credentials-2222bbbb';
    const entries = new Map([
      ['global', { account: 'tester', service: 'Claude Code-credentials' }],
      ['live', { account: 'tester', service: liveService }],
      ['stale', { account: 'tester', service: staleService }],
      ['other-account', { account: 'someone-else', service: otherAccountService }],
      ['other-service', { account: 'tester', service: 'Other App credentials-3333cccc' }],
    ]);
    mockSecuritySpawn((args) => {
      if (args[0] === 'dump-keychain') {
        return { status: 0, stdout: dumpKeychainItems([...entries.values()]) };
      }
      if (args[0] === 'delete-generic-password') {
        const service = String(args[args.indexOf('-s') + 1] ?? '');
        for (const [key, entry] of entries.entries()) {
          if (entry.service === service) entries.delete(key);
        }
        return successfulSpawnResult();
      }
      return successfulSpawnResult();
    });

    const first = await sweepStaleClaudeCodeMacOsKeychainCredentials({
      liveClaudeConfigDirs: ['/tmp/live-claude-home'],
      homeDir: '/Users/tester',
      username: 'tester',
    });
    const second = await sweepStaleClaudeCodeMacOsKeychainCredentials({
      liveClaudeConfigDirs: ['/tmp/live-claude-home'],
      homeDir: '/Users/tester',
      username: 'tester',
    });

    expect(first).toEqual({
      scanned: 5,
      deleted: [{ account: 'tester', service: staleService }],
      skipped: expect.arrayContaining([
        { account: 'tester', service: 'Claude Code-credentials', reason: 'global_service' },
        { account: 'tester', service: liveService, reason: 'live_service' },
        { account: 'someone-else', service: otherAccountService, reason: 'different_account' },
        { account: 'tester', service: 'Other App credentials-3333cccc', reason: 'not_happier_managed_service' },
      ]),
    });
    expect(second.deleted).toEqual([]);
    const deleteCalls = spawnSpy.mock.calls
      .map((call) => call[1] as readonly string[])
      .filter((args) => args[0] === 'delete-generic-password');
    expect(deleteCalls).toEqual([
      ['delete-generic-password', '-a', 'tester', '-s', staleService],
    ]);
    expect(entries.get('global')).toEqual({ account: 'tester', service: 'Claude Code-credentials' });
    expect(entries.get('live')).toEqual({ account: 'tester', service: liveService });
    expect(entries.get('other-account')).toEqual({ account: 'someone-else', service: otherAccountService });
  });

  it('never deletes a managed keychain service when the live set is unverifiable (fails closed)', async () => {
    const managedService = 'Claude Code-credentials-1111aaaa';
    mockSecuritySpawn((args) => {
      if (args[0] === 'dump-keychain') {
        return { status: 0, stdout: dumpKeychainItems([{ account: 'tester', service: managedService }]) };
      }
      return successfulSpawnResult();
    });

    const result = await sweepStaleClaudeCodeMacOsKeychainCredentials({
      liveClaudeConfigDirs: [],
      homeDir: '/Users/tester',
      username: 'tester',
    });

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([
      { account: 'tester', service: managedService, reason: 'unverifiable_live_set' },
    ]);
    expect(spawnSpy.mock.calls.some((call) => (call[1] as readonly string[])[0] === 'delete-generic-password')).toBe(false);
  });
});
