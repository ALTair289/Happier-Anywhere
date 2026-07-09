import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readObject } from './claudeCodeNativeCredentialPayload';
import { resolveClaudeCodeCredentialsFilePath } from './claudeCodeCredentialFile';

const LEGACY_REFRESH_TOKEN_KEYS = ['refreshToken', 'refresh_token', 'RT'] as const;

function stripLegacyRefreshTokenFields(value: unknown): Readonly<{
  payload: unknown;
  stripped: boolean;
}> {
  const root = readObject(value);
  const credential = readObject(root?.claudeAiOauth);
  if (!root || !credential) return { payload: value, stripped: false };
  let stripped = false;
  const nextCredential = { ...credential };
  for (const key of LEGACY_REFRESH_TOKEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(nextCredential, key)) {
      delete nextCredential[key];
      stripped = true;
    }
  }
  if (!stripped) return { payload: value, stripped: false };
  return {
    payload: {
      ...root,
      claudeAiOauth: nextCredential,
    },
    stripped: true,
  };
}

export async function stripClaudeCodeCredentialFileRefreshTokenFields(
  claudeConfigDir: string,
): Promise<Readonly<{ stripped: boolean }>> {
  const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(credentialPath, 'utf8'));
  } catch {
    return { stripped: false };
  }
  const result = stripLegacyRefreshTokenFields(parsed);
  if (!result.stripped) return { stripped: false };

  const tempPath = join(claudeConfigDir, `.credentials.refresh-strip.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(result.payload)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(tempPath, 0o600);
    }
    await rename(tempPath, credentialPath);
    if (process.platform !== 'win32') {
      await chmod(credentialPath, 0o600);
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return { stripped: true };
}
