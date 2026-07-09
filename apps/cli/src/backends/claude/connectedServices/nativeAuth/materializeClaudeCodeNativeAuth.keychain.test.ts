import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './claudeCodeCredentialScopes';
import { resolveClaudeCodeMacOsKeychainServiceName } from './claudeCodeMacOsKeychain';
import { resolveClaudeCodeCredentialsFilePath } from './claudeCodeCredentialFile';
import {
  buildClaudeConnectedServiceHomeProvenance,
  resolveClaudeConnectedServiceHomeProvenancePath,
  writeClaudeConnectedServiceHomeProvenance,
} from '../claudeConnectedServiceHomeProvenance';

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
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

function buildClaudeOauthRecord() {
  return buildConnectedServiceCredentialRecord({
    now: REALISTIC_ISSUED_AT_MS,
    serviceId: 'claude-subscription',
    profileId: 'oauth-profile',
    kind: 'oauth',
    expiresAt: REALISTIC_EXPIRES_AT_MS,
    oauth: {
      accessToken: 'selected-access-placeholder',
      refreshToken: 'selected-refresh-placeholder',
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

describe('materializeClaudeSubscriptionNativeAuthHome macOS keychain integration', () => {
  const securityInputs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    spawnSpy.mockReset();
    securityInputs.length = 0;
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  function mockSecurityProcess(result: Readonly<{ status: number | null; stdout?: string; stderr?: string }>) {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        securityInputs.push(String(chunk));
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

  function mockMissingKeychainWithWriteStatus(status: number, stderr = ''): void {
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password') return { status: 44, stderr: 'not found' };
      return { status, stderr };
    });
  }

  it('writes the derived managed macOS keychain credential with access-token-only auth after materialization', async () => {
    mockMissingKeychainWithWriteStatus(0);
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const { materializeClaudeSubscriptionNativeAuthHome } = await import('./materializeClaudeCodeNativeAuth');
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-source-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-target-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record: buildClaudeOauthRecord(),
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'oauth-profile',
      },
    });

    expect(result.status).toBe('materialized');
    expect(spawnSpy).toHaveBeenCalledWith(
      'security',
      [
        'add-generic-password',
        '-U',
        '-a',
        expect.any(String),
        '-s',
        resolveClaudeCodeMacOsKeychainServiceName({
          claudeConfigDir: targetClaudeConfigDir,
          homeDir,
        }),
        '-w',
      ],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(securityInputs.join('')).toContain('selected-access-placeholder');
    expect(securityInputs.join('')).not.toContain('selected-refresh-placeholder');
    expect(spawnSpy.mock.calls.flatMap((call) => call[1] as readonly string[])).not.toContain('Claude Code-credentials');
  });

  it('never deletes the global Claude Code keychain credential for the user default config dir', async () => {
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const { writeClaudeSubscriptionNativeAuthMacOsKeychainCredential } = await import('./materializeClaudeCodeNativeAuth');
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-home-'));
    const globalClaudeConfigDir = join(homeDir, '.claude');

    const result = await writeClaudeSubscriptionNativeAuthMacOsKeychainCredential({
      record: buildClaudeOauthRecord(),
      claudeConfigDir: globalClaudeConfigDir,
      sourceEnv: { HOME: homeDir, USER: 'tester' },
      payload: null,
    });

    expect(result).toEqual({ diagnostics: [], keychainWrite: null });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('fails closed with a blocking diagnostic and leaves the target home unchanged when the macOS keychain write fails', async () => {
    mockMissingKeychainWithWriteStatus(1, 'keychain write failed');
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const { materializeClaudeSubscriptionNativeAuthHome } = await import('./materializeClaudeCodeNativeAuth');
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-source-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-target-'));
    const previousSettings = '{"theme":"previous"}\n';
    const previousCredentials = '{"previous":true}\n';
    const previousProvenance = '{"previousProvenance":true}\n';
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    await writeFile(join(targetClaudeConfigDir, 'settings.json'), previousSettings);
    await writeFile(resolveClaudeCodeCredentialsFilePath(targetClaudeConfigDir), previousCredentials);
    await writeFile(resolveClaudeConnectedServiceHomeProvenancePath(targetClaudeConfigDir), previousProvenance);

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record: buildClaudeOauthRecord(),
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'oauth-profile',
      },
    });

    expect(result.status).toBe('diagnostic');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: targetClaudeConfigDir });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'claude_subscription_native_auth_keychain_write_failed',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        reason: 'keychain_write_failed',
      }),
    ]);
    await expect(readFile(join(targetClaudeConfigDir, 'settings.json'), 'utf8')).resolves.toBe(previousSettings);
    await expect(readFile(resolveClaudeCodeCredentialsFilePath(targetClaudeConfigDir), 'utf8')).resolves.toBe(previousCredentials);
    await expect(readFile(resolveClaudeConnectedServiceHomeProvenancePath(targetClaudeConfigDir), 'utf8')).resolves.toBe(previousProvenance);
  });

  it('rolls back self-source promoted credentials and provenance when the macOS keychain write fails', async () => {
    mockMissingKeychainWithWriteStatus(1, 'keychain write failed');
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const { materializeClaudeSubscriptionNativeAuthHome } = await import('./materializeClaudeCodeNativeAuth');
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-home-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-self-source-'));
    await writeFile(join(targetClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record: buildClaudeOauthRecord(),
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'oauth-profile',
      },
    });

    expect(result.status).toBe('diagnostic');
    await expect(lstat(resolveClaudeCodeCredentialsFilePath(targetClaudeConfigDir))).rejects.toThrow();
    await expect(lstat(resolveClaudeConnectedServiceHomeProvenancePath(targetClaudeConfigDir))).rejects.toThrow();
  });

  it('overwrites a newer legacy target keychain credential with access-token-only auth after staged promotion', async () => {
    mockSecuritySpawn((args) => {
      if (args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'keychain-newer-access-placeholder',
            refreshToken: 'keychain-newer-refresh-placeholder',
            expiresAt: REALISTIC_EXPIRES_AT_MS + 60_000,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
          },
        }) };
      }
      if (args[0] === 'find-generic-password') {
        return { status: 0, stdout: [
        'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
        'version: 512',
        'class: "genp"',
        'attributes:',
        '    "acct"<blob>="tester"',
        '    "mdat"<timedate>=0x32303236303630353132303130305A00  "20260605120100Z\\000"',
      ].join('\n') };
      }
      return { status: 0 };
    });
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const { materializeClaudeSubscriptionNativeAuthHome } = await import('./materializeClaudeCodeNativeAuth');
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-source-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-target-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const record = buildClaudeOauthRecord();
    await writeClaudeConnectedServiceHomeProvenance({
      claudeConfigDir: targetClaudeConfigDir,
      provenance: buildClaudeConnectedServiceHomeProvenance({
        record,
        selectionDescriptor: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'oauth-profile',
        },
      }),
    });

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, USER: 'tester', CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'oauth-profile',
      },
    });

    expect(result.status).toBe('materialized');
    expect(spawnSpy.mock.calls.at(-1)).toEqual([
      'security',
      [
        'add-generic-password',
        '-U',
        '-a',
        'tester',
        '-s',
        resolveClaudeCodeMacOsKeychainServiceName({
          claudeConfigDir: targetClaudeConfigDir,
          homeDir,
        }),
        '-w',
      ],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    ]);
    expect(securityInputs.join('')).toContain('selected-access-placeholder');
    expect(JSON.stringify(spawnSpy.mock.calls)).not.toContain('selected-refresh-placeholder');
    expect(securityInputs.join('')).not.toContain('selected-refresh-placeholder');
    expect(securityInputs.join('')).not.toContain('keychain-newer-refresh-placeholder');
  });
});
