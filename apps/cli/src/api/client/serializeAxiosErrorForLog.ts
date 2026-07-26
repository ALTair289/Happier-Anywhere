import axios from 'axios';

function redactUrlForLog(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const redactTelegramBotTokenPath = (input: string): string => input.replace(
    /\/bot[^/?#]+(?=\/|$)/u,
    '/<redacted>',
  );
  const redactUrlUserInfo = (input: string): string => input
    .replace(/^([a-z][a-z\d+.-]*:\/\/)([^/?#@]+@)+/iu, '$1')
    .replace(/^(\/\/)([^/?#@]+@)+/u, '$1')
    .replace(/^([^/?#:@\s]+:)([^/?#@]+@)+/u, '')
    .replace(
      /^([^/?#:@\s]+@)+(?=(?:localhost|\[[^\]]+\]|[^/?#@]+\.[^/?#@]+|[^/?#@]+:\d+)(?:[/?#]|$))/iu,
      '',
    );
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return redactTelegramBotTokenPath(redactUrlUserInfo(parsed.toString()));
  } catch {
    // Best-effort: strip query/hash to avoid leaking secrets in URLs.
    return redactTelegramBotTokenPath(redactUrlUserInfo(value.split('?')[0]?.split('#')[0] ?? value));
  }
}

const LOG_URL_TOKEN_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+|(?<!:)\/\/[^\s"'<>]+|\b[^/?#:@\s]+(?::[^/?#@\s]+)?@(?:localhost|\[[^\]\s]+\]|[^/?#@\s]+\.[^/?#@\s]+|[^/?#@\s]+:\d+)[^\s"'<>]*/giu;

function redactAuthorizationTokensForLog(value: string): string {
  return value
    .replace(/\b(Authorization\s*[:=]\s*)(?:Bearer|Basic)?\s*[^\s,;]+/giu, '$1<redacted>')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 <redacted>');
}

function redactMessageForLog(raw: unknown): string {
  return redactAuthorizationTokensForLog(
    String(raw).replace(LOG_URL_TOKEN_PATTERN, (match) => redactUrlForLog(match) ?? '<redacted>'),
  );
}

function readSafeErrorCode(error: Error): string | undefined {
    const raw = (error as { code?: unknown }).code;
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    return /^[A-Za-z0-9_.:-]{1,160}$/u.test(value) ? value : undefined;
}

function readSafeResponseField(data: unknown, field: 'error' | 'reason'): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const raw = (data as Record<string, unknown>)[field];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return /^[A-Za-z0-9_.:-]{1,160}$/u.test(value) ? value : undefined;
}

function readSafeResponseCorrelationId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const raw = (data as Record<string, unknown>).correlationId;
  return typeof raw === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(raw) ? raw : undefined;
}

function readSafeResponseRetryAfterMs(data: unknown): number | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const raw = (data as Record<string, unknown>).retryAfterMs;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

// IMPORTANT: Do not log axios error.config.headers.Authorization or request body, which may contain secrets.
export function serializeAxiosErrorForLog(error: unknown): Record<string, unknown> {
  if (axios.isAxiosError(error)) {
    const responseError = readSafeResponseField(error.response?.data, 'error');
    const responseReason = readSafeResponseField(error.response?.data, 'reason');
    const responseCorrelationId = readSafeResponseCorrelationId(error.response?.data);
    const responseRetryAfterMs = readSafeResponseRetryAfterMs(error.response?.data);
    return {
      name: error.name,
      message: redactMessageForLog(error.message),
      code: error.code,
      status: error.response?.status,
      method: typeof error.config?.method === 'string' ? error.config.method.toUpperCase() : undefined,
      url: redactUrlForLog(error.config?.url),
      ...(responseError ? { responseError } : {}),
      ...(responseReason ? { responseReason } : {}),
      ...(responseCorrelationId ? { responseCorrelationId } : {}),
      ...(responseRetryAfterMs !== undefined ? { responseRetryAfterMs } : {}),
    };
  }

  if (error instanceof Error) {
    const code = readSafeErrorCode(error);
    return {
      name: error.name,
      message: redactMessageForLog(error.message),
      ...(code ? { code } : {}),
    };
  }

  return { message: redactMessageForLog(error) };
}
