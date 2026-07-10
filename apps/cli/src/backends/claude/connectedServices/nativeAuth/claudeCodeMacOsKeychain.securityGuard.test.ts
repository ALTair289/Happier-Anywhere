import { afterEach, describe, expect, it, vi } from 'vitest';

// A PLAIN spawn stand-in with NO vitest `.mock` marker: it emulates a test that failed to mock the
// `security` boundary properly. The structural guard must block it under VITEST before it ever runs,
// so the real `security` binary can never be reached (a prior escape wrote ~266 real keychain items).
const { plainSpawn, realSpawnInvocations } = vi.hoisted(() => {
  const realSpawnInvocations: string[][] = [];
  const plainSpawn = (_command: string, args: readonly string[]) => {
    realSpawnInvocations.push([...args]);
    throw new Error('the real security binary must never be spawned in tests');
  };
  return { plainSpawn, realSpawnInvocations };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: plainSpawn };
});

describe('claudeCodeMacOsKeychain security spawn boundary guard', () => {
  afterEach(() => {
    realSpawnInvocations.length = 0;
  });

  it('blocks an un-mocked (real) security spawn under VITEST instead of touching the keychain', async () => {
    expect(process.env.VITEST).toBeTruthy();
    const { sweepStaleClaudeCodeMacOsKeychainCredentials } = await import('./claudeCodeMacOsKeychain');
    await expect(
      sweepStaleClaudeCodeMacOsKeychainCredentials({ homeDir: '/Users/tester', username: 'tester' }),
    ).rejects.toThrow('claude_code_keychain_real_security_spawn_blocked_in_test');
    // The plain (real-binary) spawn must never have been reached.
    expect(realSpawnInvocations).toEqual([]);
  });
});
