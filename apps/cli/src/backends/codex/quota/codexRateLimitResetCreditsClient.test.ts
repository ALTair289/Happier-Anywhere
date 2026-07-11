import { describe, expect, it, vi } from 'vitest';

import {
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimitResetCredits,
} from './codexRateLimitResetCreditsClient';

describe('codexRateLimitResetCreditsClient', () => {
  it('reads Codex reset-credit inventory with connected account headers', async () => {
    const fetchRuntime = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({ available_count: 2, credits: [] }),
    } as Response));

    await expect(fetchCodexRateLimitResetCredits({
      accessToken: 'access-token',
      accountId: 'acct-1',
      resetCreditsUrl: 'https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits',
      fetchRuntime,
    })).resolves.toEqual({
      ok: true,
      response: { available_count: 2, credits: [] },
    });

    expect(fetchRuntime).toHaveBeenCalledWith(
      'https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'ChatGPT-Account-Id': 'acct-1',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('posts the official explicit-id reset-credit wire body', async () => {
    const fetchRuntime = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 'reset', windows_reset: 2 }),
    } as Response));

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      accountId: 'acct-1',
      creditId: 'credit-1',
      redeemRequestId: 'reset-req-1',
      consumeUrl: 'https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits/consume',
      fetchRuntime,
    })).resolves.toEqual({
      ok: true,
      response: { code: 'reset', windows_reset: 2 },
      outcome: { code: 'reset', windowsReset: 2 },
    });

    expect(fetchRuntime).toHaveBeenCalledWith(
      'https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits/consume',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'ChatGPT-Account-Id': 'acct-1',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        }),
        body: JSON.stringify({ redeem_request_id: 'reset-req-1', credit_id: 'credit-1' }),
      }),
    );
  });

  it('posts the official aggregate reset-credit wire body without a credit id', async () => {
    const fetchRuntime = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 'reset', windows_reset: 1 }),
    } as Response));

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      accountId: 'acct-1',
      creditId: '   ',
      redeemRequestId: 'reset-req-1',
      consumeUrl: 'https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits/consume',
      fetchRuntime,
    })).resolves.toEqual({
      ok: true,
      response: { code: 'reset', windows_reset: 1 },
      outcome: { code: 'reset', windowsReset: 1 },
    });
    expect(fetchRuntime).toHaveBeenCalledWith(
      'https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits/consume',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ redeem_request_id: 'reset-req-1' }),
      }),
    );
  });

  it('rejects a consume request with no redeem request id before provider I/O', async () => {
    const fetchRuntime = vi.fn();

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      accountId: 'acct-1',
      creditId: 'credit-1',
      redeemRequestId: '   ',
      consumeUrl: 'https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits/consume',
      fetchRuntime,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'codex_reset_credit_consume_failed',
      providerCode: 'missing_redeem_request_id',
    });
    expect(fetchRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['reset', 2, { code: 'reset', windowsReset: 2 }],
    ['nothing_to_reset', 0, { code: 'nothing_to_reset', windowsReset: 0 }],
    ['no_credit', 0, { code: 'no_credit', windowsReset: 0 }],
    ['already_redeemed', 0, { code: 'already_redeemed', windowsReset: 0 }],
  ] as const)('parses the provider %s outcome', async (code, windowsReset, outcome) => {
    const fetchRuntime = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({ code, windows_reset: windowsReset }),
    } as Response));

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      accountId: 'acct-1',
      creditId: 'credit-1',
      redeemRequestId: 'reset-req-1',
      fetchRuntime,
    })).resolves.toMatchObject({ ok: true, outcome });
  });

  it('rejects a successful HTTP response with an unknown provider outcome', async () => {
    const fetchRuntime = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 'future_code', windows_reset: 0 }),
    } as Response));

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      accountId: 'acct-1',
      creditId: 'credit-1',
      redeemRequestId: 'reset-req-1',
      fetchRuntime,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'codex_reset_credit_consume_failed',
      status: 200,
      providerCode: 'invalid_consume_response',
    });
  });

  it('returns provider status details for rejected reset-credit consume requests', async () => {
    const fetchRuntime = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ code: 'no_available_reset_credits' }),
    } as Response));

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      accountId: null,
      creditId: 'credit-1',
      redeemRequestId: 'reset-req-1',
      consumeUrl: 'https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits/consume',
      fetchRuntime,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'codex_reset_credit_consume_failed',
      status: 409,
      providerCode: 'no_available_reset_credits',
    });
  });
});
