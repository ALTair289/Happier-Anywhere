import {
  redactBugReportSensitiveText,
  trimBugReportTextToMaxBytes,
} from '@happier-dev/protocol';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';

const ERROR_TEXT_MAX_BYTES = 4_096;
const ERROR_NAME_MAX_CHARS = 160;
const ERROR_CAUSE_MAX_DEPTH = 2;

export type SerializedOutboundError = Readonly<{
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SerializedOutboundError;
}>;

function sanitizeText(value: unknown): string {
  return trimBugReportTextToMaxBytes(
    redactBugReportSensitiveText(String(value)),
    ERROR_TEXT_MAX_BYTES,
  ).trim();
}

function sanitizeStack(value: string): string {
  const urlAndAuthorizationRedacted = serializeAxiosErrorForLog(new Error(value)).message;
  return sanitizeText(urlAndAuthorizationRedacted);
}

function sanitizeMessage(value: unknown): string {
  const urlAndAuthorizationRedacted = serializeAxiosErrorForLog(new Error(String(value))).message;
  return sanitizeText(urlAndAuthorizationRedacted);
}

function sanitizeName(value: unknown): string {
  const sanitized = sanitizeText(value).replace(/[^A-Za-z0-9_.:-]/gu, '');
  return sanitized.slice(0, ERROR_NAME_MAX_CHARS) || 'Error';
}

function readCause(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { cause?: unknown }).cause;
}

function readStringField(error: unknown, field: 'name' | 'message' | 'stack' | 'code'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function serialize(error: unknown, depth: number): SerializedOutboundError {
  const safe = serializeAxiosErrorForLog(error);
  const name = sanitizeName(readStringField(error, 'name') ?? safe.name ?? 'Error');
  const message = sanitizeMessage(readStringField(error, 'message') ?? safe.message ?? error) || 'Unknown error';
  const rawStack = readStringField(error, 'stack');
  const stack = rawStack
    ? sanitizeStack(rawStack)
    : '';
  const rawCode = readStringField(error, 'code') ?? safe.code;
  const code = typeof rawCode === 'string' ? sanitizeName(rawCode) : '';
  const cause = depth < ERROR_CAUSE_MAX_DEPTH ? readCause(error) : undefined;

  return {
    name,
    message,
    ...(stack ? { stack } : {}),
    ...(code ? { code } : {}),
    ...(cause === undefined ? {} : { cause: serialize(cause, depth + 1) }),
  };
}

export function serializeOutboundError(error: unknown): SerializedOutboundError {
  return serialize(error, 0);
}
