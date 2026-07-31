import { configuration } from '@/configuration';

import { resolveLoopbackHttpUrl } from './loopbackUrl';

export function normalizeServerHttpBaseUrl(serverUrl: string): string {
  return resolveLoopbackHttpUrl(serverUrl).replace(/\/+$/, '');
}

export function resolveServerHttpBaseUrl(): string {
  return normalizeServerHttpBaseUrl(configuration.apiServerUrl);
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
