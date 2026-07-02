import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import {
  classifyClaudeCodeCredentialHealth,
  type ClaudeCodeCredentialHealth,
} from './claudeCodeCredentialHealth';
import { parseClaudeCodeCredentialScopes } from './claudeCodeCredentialScopes';

export type ClaudeCodeNativeCredentialPayload = Readonly<{
  claudeAiOauth: Readonly<{
    accessToken: string;
    refreshToken: string;
    expiresAt?: number;
    scopes: readonly string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  }>;
}>;

export type ClaudeCodeCredentialFileParseResult =
  | Readonly<{
      status: 'ok';
      hasAccessToken: boolean;
      hasRefreshToken: boolean;
      expiresAt: number | null;
      scopes: readonly string[];
    }>
  | Readonly<{
      status: 'unsupported_shape';
      hasAccessToken: false;
      hasRefreshToken: false;
      expiresAt: null;
      scopes: readonly string[];
    }>;

export type ClaudeCodeCredentialPayloadBuildResult =
  | Readonly<{ status: 'ok'; payload: ClaudeCodeNativeCredentialPayload }>
  | Readonly<{ status: 'diagnostic'; health: ClaudeCodeCredentialHealth }>;

function readObject(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text ?? undefined;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function resolveClaudeCodeCredentialsFilePath(claudeConfigDir: string): string {
  return join(claudeConfigDir, '.credentials.json');
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]),
    );
  }
  return value;
}

export function computeClaudeCodeCredentialFingerprint(payload: unknown): string {
  const canonical = JSON.stringify(canonicalizeJsonValue(payload));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function computeClaudeCodeCredentialAccountProofFingerprint(payload: unknown): string | null {
  const root = readObject(payload);
  const credential = readObject(root?.claudeAiOauth);
  const accessToken = readString(credential?.accessToken);
  const refreshToken = readString(credential?.refreshToken);
  if (!accessToken || !refreshToken) return null;
  const subscriptionType = readOptionalString(credential?.subscriptionType);
  const rateLimitTier = readOptionalString(credential?.rateLimitTier);

  return computeClaudeCodeCredentialFingerprint({
    claudeAiOauth: {
      accessToken,
      refreshToken,
      scopes: parseClaudeCodeCredentialScopes(
        Array.isArray(credential?.scopes)
          ? credential.scopes.filter((scope): scope is string => typeof scope === 'string')
          : typeof credential?.scopes === 'string'
            ? credential.scopes
            : null,
      ),
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(rateLimitTier ? { rateLimitTier } : {}),
    },
  });
}

export function parseClaudeCodeCredentialFile(value: unknown): ClaudeCodeCredentialFileParseResult {
  const root = readObject(value);
  const credential = readObject(root?.claudeAiOauth);
  if (!credential) {
    return {
      status: 'unsupported_shape',
      hasAccessToken: false,
      hasRefreshToken: false,
      expiresAt: null,
      scopes: [],
    };
  }

  return {
    status: 'ok',
    hasAccessToken: Boolean(readString(credential.accessToken)),
    hasRefreshToken: Boolean(readString(credential.refreshToken)),
    expiresAt: readNumber(credential.expiresAt),
    scopes: parseClaudeCodeCredentialScopes(
      Array.isArray(credential.scopes)
        ? credential.scopes.filter((scope): scope is string => typeof scope === 'string')
        : typeof credential.scopes === 'string'
          ? credential.scopes
          : null,
    ),
  };
}

export function buildClaudeCodeCredentialPayload(
  record: ConnectedServiceCredentialRecordV1,
): ClaudeCodeCredentialPayloadBuildResult {
  const health = classifyClaudeCodeCredentialHealth(record);
  if (health.status !== 'ok' || record.kind !== 'oauth') {
    return { status: 'diagnostic', health };
  }
  const raw = readObject(record.oauth.raw);
  const providerCredential = readObject(raw?.claudeAiOauth) ?? readObject(raw?.['claude.ai_oauth']);
  const subscriptionType = readOptionalString(providerCredential?.subscriptionType);
  const rateLimitTier = readOptionalString(providerCredential?.rateLimitTier);

  const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
    ? record.expiresAt
    : null;

  return {
    status: 'ok',
    payload: {
      claudeAiOauth: {
        accessToken: record.oauth.accessToken,
        refreshToken: record.oauth.refreshToken,
        // A null/unknown expiry must NOT be coerced to 0: writing `expiresAt: 0`
        // produces an immediately-expired credential (a latent fail-open/fail-closed
        // trap depending on the consumer). Omit it so the value reads as "unknown".
        ...(expiresAt !== null ? { expiresAt } : {}),
        scopes: parseClaudeCodeCredentialScopes(record.oauth.scope),
        ...(subscriptionType ? { subscriptionType } : {}),
        ...(rateLimitTier ? { rateLimitTier } : {}),
      },
    },
  };
}

export async function writeClaudeCodeCredentialsFile(params: Readonly<{
  claudeConfigDir: string;
  payload: ClaudeCodeNativeCredentialPayload;
}>): Promise<string> {
  await mkdir(params.claudeConfigDir, { recursive: true });
  const credentialPath = resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir);
  const tempPath = join(params.claudeConfigDir, `.credentials.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(params.payload)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(tempPath, 0o600);
    }
    await rename(tempPath, credentialPath);
    if (process.platform !== 'win32') {
      await chmod(credentialPath, 0o600);
    }
    return credentialPath;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
