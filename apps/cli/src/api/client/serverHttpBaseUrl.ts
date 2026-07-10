import { configuration } from '@/configuration';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { existsSync, readFileSync } from 'node:fs';

import { resolveLoopbackHttpUrl } from './loopbackUrl';

function readRuntimeEnvServerUrl(env: NodeJS.ProcessEnv): string | null {
  const local = typeof env.HAPPIER_LOCAL_SERVER_URL === 'string' ? env.HAPPIER_LOCAL_SERVER_URL.trim() : '';
  if (local) return local;

  const server = typeof env.HAPPIER_SERVER_URL === 'string' ? env.HAPPIER_SERVER_URL.trim() : '';
  if (server) return server;

  const publicServer = typeof env.HAPPIER_PUBLIC_SERVER_URL === 'string' ? env.HAPPIER_PUBLIC_SERVER_URL.trim() : '';
  return publicServer || null;
}

function readEnvFileValue(raw: string, key: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator).trim() !== key) continue;
    const value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      return value.slice(1, -1).trim() || null;
    }
    return value || null;
  }
  return null;
}

function readStackEnvServerUrl(env: NodeJS.ProcessEnv): string | null {
  const envFile = expandHomeDirPath((env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim(), env);
  if (!envFile || !existsSync(envFile)) return null;
  try {
    const raw = readFileSync(envFile, 'utf8');
    return readEnvFileValue(raw, 'HAPPIER_LOCAL_SERVER_URL')
      ?? readEnvFileValue(raw, 'HAPPIER_SERVER_URL')
      ?? readEnvFileValue(raw, 'HAPPIER_PUBLIC_SERVER_URL');
  } catch {
    return null;
  }
}

export function normalizeServerHttpBaseUrl(serverUrl: string): string {
  return resolveLoopbackHttpUrl(serverUrl).replace(/\/+$/, '');
}

function readLiveServerUrl(): string {
  return readStackEnvServerUrl(process.env)
    ?? readRuntimeEnvServerUrl(process.env)
    ?? configuration.apiServerUrl;
}

export function resolveServerHttpBaseUrl(): string {
  return normalizeServerHttpBaseUrl(readLiveServerUrl());
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

export function isServerHttpEndpointConnectionFailure(error: unknown): boolean {
  const code = readErrorCode(error);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return true;
  const message = readErrorMessage(error);
  if (/\b(?:ECONNREFUSED|ENOTFOUND)\b/i.test(message)) return true;
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  return cause !== undefined ? isServerHttpEndpointConnectionFailure(cause) : false;
}
