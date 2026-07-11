export const DEFAULT_CODEX_RATE_LIMIT_RESET_CREDITS_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

export const DEFAULT_CODEX_RATE_LIMIT_RESET_CREDIT_CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';

export type CodexRateLimitResetCreditsFetch = (url: string, init: RequestInit) => Promise<Response>;

export type FetchCodexRateLimitResetCreditsResult =
  | Readonly<{ ok: true; response: unknown | null }>
  | Readonly<{
      ok: false;
      errorCode: 'codex_reset_credit_fetch_failed' | 'codex_reset_credit_fetch_network_error';
      status?: number;
      providerCode?: string | null;
    }>;

export type ConsumeCodexRateLimitResetCreditResult =
  | Readonly<{
      ok: true;
      response: unknown | null;
      outcome: ConsumeCodexRateLimitResetCreditOutcome;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'codex_reset_credit_consume_failed' | 'codex_reset_credit_consume_network_error';
      status?: number;
      providerCode?: string | null;
    }>;

export type ConsumeCodexRateLimitResetCreditOutcomeCode =
  | 'reset'
  | 'nothing_to_reset'
  | 'no_credit'
  | 'already_redeemed';

export type ConsumeCodexRateLimitResetCreditOutcome = Readonly<{
  code: ConsumeCodexRateLimitResetCreditOutcomeCode;
  windowsReset: number;
}>;

function readProviderCode(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const direct = record.code ?? record.error_code ?? record.errorCode;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const error = record.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const nested = (error as Record<string, unknown>).code ?? (error as Record<string, unknown>).error_code;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : null;
}

async function readJsonBestEffort(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseConsumeOutcome(value: unknown): ConsumeCodexRateLimitResetCreditOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code = record.code;
  if (
    code !== 'reset'
    && code !== 'nothing_to_reset'
    && code !== 'no_credit'
    && code !== 'already_redeemed'
  ) {
    return null;
  }
  const rawWindowsReset = record.windows_reset;
  if (
    rawWindowsReset !== undefined
    && (typeof rawWindowsReset !== 'number' || !Number.isFinite(rawWindowsReset))
  ) {
    return null;
  }
  return {
    code,
    windowsReset: typeof rawWindowsReset === 'number'
      ? Math.max(0, Math.trunc(rawWindowsReset))
      : 0,
  };
}

export async function fetchCodexRateLimitResetCredits(params: Readonly<{
  accessToken: string;
  accountId?: string | null;
  resetCreditsUrl?: string;
  fetchRuntime?: CodexRateLimitResetCreditsFetch;
}>): Promise<FetchCodexRateLimitResetCreditsResult> {
  const accessToken = params.accessToken.trim();
  if (!accessToken) {
    return {
      ok: false,
      errorCode: 'codex_reset_credit_fetch_failed',
      providerCode: 'missing_access_token',
    };
  }

  const fetchRuntime = params.fetchRuntime ?? fetch;
  try {
    const response = await fetchRuntime(
      params.resetCreditsUrl ?? DEFAULT_CODEX_RATE_LIMIT_RESET_CREDITS_URL,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(params.accountId ? { 'ChatGPT-Account-Id': params.accountId } : {}),
          Accept: 'application/json',
        },
      },
    );
    const json = await readJsonBestEffort(response);
    if (!response.ok) {
      return {
        ok: false,
        errorCode: 'codex_reset_credit_fetch_failed',
        status: response.status,
        providerCode: readProviderCode(json),
      };
    }
    return { ok: true, response: json };
  } catch {
    return { ok: false, errorCode: 'codex_reset_credit_fetch_network_error' };
  }
}

export async function consumeCodexRateLimitResetCredit(params: Readonly<{
  accessToken: string;
  accountId?: string | null;
  /** Id of the rate-limit-reset credit to redeem (from the credits inventory `id`). */
  creditId?: string | null;
  /** Per-redeem dedup id sent as `redeem_request_id`. Stable retries reuse the same value. */
  redeemRequestId: string;
  consumeUrl?: string;
  fetchRuntime?: CodexRateLimitResetCreditsFetch;
  signal?: AbortSignal;
}>): Promise<ConsumeCodexRateLimitResetCreditResult> {
  const accessToken = params.accessToken.trim();
  const creditId = typeof params.creditId === 'string' ? params.creditId.trim() : '';
  const redeemRequestId = params.redeemRequestId.trim();
  if (!accessToken) {
    return {
      ok: false,
      errorCode: 'codex_reset_credit_consume_failed',
      providerCode: 'missing_access_token',
    };
  }
  if (!redeemRequestId) {
    return {
      ok: false,
      errorCode: 'codex_reset_credit_consume_failed',
      providerCode: 'missing_redeem_request_id',
    };
  }

  const fetchRuntime = params.fetchRuntime ?? fetch;
  try {
    const response = await fetchRuntime(
      params.consumeUrl ?? DEFAULT_CODEX_RATE_LIMIT_RESET_CREDIT_CONSUME_URL,
      {
        method: 'POST',
        signal: params.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(params.accountId ? { 'ChatGPT-Account-Id': params.accountId } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          redeem_request_id: redeemRequestId,
          ...(creditId ? { credit_id: creditId } : {}),
        }),
      },
    );
    const json = await readJsonBestEffort(response);
    if (!response.ok) {
      return {
        ok: false,
        errorCode: 'codex_reset_credit_consume_failed',
        status: response.status,
        providerCode: readProviderCode(json),
      };
    }
    const outcome = parseConsumeOutcome(json);
    if (!outcome) {
      return {
        ok: false,
        errorCode: 'codex_reset_credit_consume_failed',
        status: response.status,
        providerCode: 'invalid_consume_response',
      };
    }
    return { ok: true, response: json, outcome };
  } catch {
    return { ok: false, errorCode: 'codex_reset_credit_consume_network_error' };
  }
}
