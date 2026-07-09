import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

const { renameSpy, writeFileSpy } = vi.hoisted(() => ({
  renameSpy: vi.fn(),
  writeFileSpy: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameSpy.mockImplementation(actual.rename);
  writeFileSpy.mockImplementation(actual.writeFile);
  return {
    ...actual,
    rename: renameSpy,
    writeFile: writeFileSpy,
  };
});

describe('Claude Code credential file write policy', () => {
  afterEach(() => {
    if (vi.isMockFunction(logger.info)) vi.mocked(logger.info).mockRestore();
    renameSpy.mockClear();
    writeFileSpy.mockClear();
  });

  it('does not replace .credentials.json when the materialized fingerprint is unchanged', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const { resolveClaudeCodeCredentialsFilePath, writeClaudeCodeCredentialsFile } = await import(
      './claudeCodeCredentialFile'
    );
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-credential-skip-'));
    const payload = {
      claudeAiOauth: {
        accessToken: 'stable-access-placeholder',
        refreshToken: 'stable-refresh-placeholder',
        expiresAt: 1_800_000_000_000,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    };

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload,
      preserveNewerExistingCredential: false,
    });
    renameSpy.mockClear();
    writeFileSpy.mockClear();

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload,
      preserveNewerExistingCredential: false,
    });

    expect(renameSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      '[DAEMON RUN] Claude Code credential file decision',
      expect.objectContaining({ decision: 'skip_fingerprint_match' }),
    );
    await expect(readFile(resolveClaudeCodeCredentialsFilePath(claudeConfigDir), 'utf8')).resolves.toContain(
      'stable-access-placeholder',
    );
  });

  it('commits a genuine credential change with a temp-file rename and never truncates the live file', async () => {
    const { resolveClaudeCodeCredentialsFilePath, writeClaudeCodeCredentialsFile } = await import(
      './claudeCodeCredentialFile'
    );
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-credential-atomic-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    const buildPayload = (accessToken: string) => ({
      claudeAiOauth: {
        accessToken,
        refreshToken: 'refresh-placeholder',
        expiresAt: 1_800_000_000_000,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    });

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: buildPayload('first-access-placeholder'),
      preserveNewerExistingCredential: false,
    });
    renameSpy.mockClear();
    writeFileSpy.mockClear();

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: buildPayload('rotated-access-placeholder'),
      preserveNewerExistingCredential: false,
    });

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const [tempPath] = writeFileSpy.mock.calls[0] ?? [];
    expect(typeof tempPath).toBe('string');
    expect(basename(String(tempPath))).toMatch(/^\.credentials\.[0-9a-f-]+\.tmp$/);
    expect(String(tempPath)).not.toBe(credentialPath);
    expect(renameSpy).toHaveBeenCalledWith(tempPath, credentialPath);
    await expect(readFile(credentialPath, 'utf8')).resolves.toContain('rotated-access-placeholder');
  });
});
