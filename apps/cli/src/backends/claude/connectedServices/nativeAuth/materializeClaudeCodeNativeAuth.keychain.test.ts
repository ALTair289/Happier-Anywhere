import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './claudeCodeCredentialScopes';
import { resolveClaudeCodeCredentialsFilePath } from './claudeCodeCredentialFile';
import { resetScheduledStaleClaudeCodeMacOsKeychainSweepKeysForTests } from './materializeClaudeCodeNativeAuth';

// AT-4: the sweep dedupe Set is module-level; reset between tests for order-determinism on darwin.
beforeEach(() => {
  resetScheduledStaleClaudeCodeMacOsKeychainSweepKeysForTests();
});

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

  it('does not create a derived macOS keychain credential after materialization', async () => {
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
    const securityCommands = spawnSpy.mock.calls.map((call) => call[1] as readonly string[]);
    expect(securityCommands.some((args) => args[0] === 'add-generic-password')).toBe(false);
    expect(securityInputs).toEqual([]);
    await expect(readFile(resolveClaudeCodeCredentialsFilePath(targetClaudeConfigDir), 'utf8')).resolves.toContain(
      'selected-access-placeholder',
    );
  });

});
